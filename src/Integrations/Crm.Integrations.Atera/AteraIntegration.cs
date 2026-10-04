using System.Globalization;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

public static class AteraTypes
{
    public const string System = "atera";
    public const string Customer = "Customer";
    public const string Contact = "Contact";
    public const string CreateCustomer = "create-customer";
    public const string UpdateCustomer = "update-customer";
    public const string SetSla = "set-sla";
    public const string CreateTicket = "create-ticket";
}

internal static class AteraMapping
{
    private static readonly Dictionary<string, string> Countries = new(StringComparer.OrdinalIgnoreCase)
    {
        ["norway"] = "NO", ["norge"] = "NO", ["sweden"] = "SE", ["sverige"] = "SE", ["denmark"] = "DK", ["danmark"] = "DK",
        ["finland"] = "FI", ["germany"] = "DE", ["united kingdom"] = "GB",
    };

    public static ExternalRecordInput ToRecord(AteraCustomer c) => new(
        AteraTypes.System, AteraTypes.Customer, c.CustomerId.ToString(CultureInfo.InvariantCulture), c.Name, c, c.LastModified,
        OrgNumber(c.BusinessNumber), Phone: c.Phone, Domain: c.Domain);

    public static ExternalRecordInput ToRecord(AteraContact c) => new(
        AteraTypes.System, AteraTypes.Contact, c.ContactId.ToString(CultureInfo.InvariantCulture),
        string.Join(' ', new[] { c.FirstName, c.LastName }.Where(s => !string.IsNullOrWhiteSpace(s))) is { Length: > 0 } name ? name : c.Email ?? $"#{c.ContactId}",
        c, c.LastModified, Email: c.Email, Phone: c.Phone ?? c.MobilePhone,
        ParentExternalId: c.CustomerId.ToString(CultureInfo.InvariantCulture), IsGone: c.InIgnoreMode, IsPerson: true);

    public static ExternalOrganizationData ToOrganizationData(AteraCustomer c) => new(
        c.Name,
        OrgNumber(c.BusinessNumber),
        null,
        c.Phone,
        c.Website,
        string.IsNullOrWhiteSpace(c.Domain) ? [] : [c.Domain.Trim().ToLowerInvariant()],
        c.Address is null && c.City is null ? null : new AddressData(c.Address, c.ZipCode, c.City, CountryCode(c.Country)),
        null,
        null);

    public static AteraCustomerWrite ToWrite(OrganizationSyncView o)
    {
        var address = o.VisitAddress.Street is not null || o.VisitAddress.City is not null ? o.VisitAddress : o.PostalAddress;
        return new AteraCustomerWrite(o.Name, o.OrgNumber, o.Domains.Count > 0 ? o.Domains[0] : null, address.Street, address.City, address.PostalCode,
            address.CountryCode is "NO" ? "Norway" : address.CountryCode, o.Phone, o.Website);
    }

    /// <summary>Atera's BusinessNumber is free text; only a Norwegian-looking 9-digit number is used for matching.</summary>
    public static string? OrgNumber(string? businessNumber)
    {
        var digits = businessNumber is null ? string.Empty : new string(businessNumber.Where(char.IsAsciiDigit).ToArray());
        return digits.Length == 9 ? digits : null;
    }

    public static string? CountryCode(string? country) =>
        country is null ? null : country.Length == 2 ? country.ToUpperInvariant() : Countries.GetValueOrDefault(country.Trim());
}

internal sealed class AteraAdapter(IOptions<AteraOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => AteraTypes.System;

    // Switched on for the CRM; calls to Atera run in crm-worker, the only host with the API key (DEV-04-AC05).
    public bool IsEnabled => options.Value.Enabled;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } =
    [
        new(AteraTypes.System, AteraTypes.Customer, EntityTypes.Organization),
        new(AteraTypes.System, AteraTypes.Contact, EntityTypes.Contact, AteraTypes.Customer),
    ];

    public string? CreateOrganizationOperation => options.Value.WriteEnabled ? AteraTypes.CreateCustomer : null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == AteraTypes.Customer && ExternalRecordStore.Read<AteraCustomer>(record) is { } c ? AteraMapping.ToOrganizationData(c) : null;

    public ExternalContactData? ToContactData(ExternalRecord record) =>
        record.ExternalType == AteraTypes.Contact && ExternalRecordStore.Read<AteraContact>(record) is { } c
            ? new ExternalContactData(c.FirstName ?? string.Empty, c.LastName ?? string.Empty, c.Email, c.Phone, c.MobilePhone, c.JobTitle)
            : null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            return new ConnectionTestResult(false, "The Atera API key is not configured on this instance.");
        }

        try
        {
            await using var enumerator = services.GetRequiredService<IAteraClient>().GetCustomersAsync(cancellationToken).GetAsyncEnumerator(cancellationToken);
            await enumerator.MoveNextAsync();
            return new ConnectionTestResult(true, "Connected to Atera.");
        }
        catch (Exception ex) when (ex is HttpRequestException or AteraApiException)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }
}

/// <summary>Full scan of Atera customers (Atera has no changed-since filter); unchanged payloads are skipped by hash.</summary>
public sealed class AteraCustomerSyncJob(
    IAteraClient client,
    ExternalRecordStore records,
    ExternalLinkService links,
    SyncRunner runner,
    ICustomersApi customers,
    TimeProvider timeProvider,
    IOptions<AteraOptions> options,
    ILogger<AteraCustomerSyncJob> logger)
{
    public const string JobId = "atera-customers";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera customer sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var scanStarted = timeProvider.GetUtcNow();
            IOrganizationMatcher? matcher = null;
            int autoLinked = 0;
            await foreach (var customer in client.GetCustomersAsync(ct))
            {
                progress.Read++;
                var outcome = await records.UpsertAsync(AteraMapping.ToRecord(customer), ct);
                if (!outcome.Changed)
                {
                    continue;
                }

                progress.Changed++;
                if (options.Value.AutoLinkByOrgNumber &&
                    await links.FindByExternalAsync(AteraTypes.System, AteraTypes.Customer, outcome.Record.ExternalId, ct) is null)
                {
                    matcher ??= await customers.CreateMatcherAsync(ct);
                    if (matcher.Match(AteraMapping.ToOrganizationData(customer)) is [{ IsExact: true } exact] &&
                        (await links.LinkAsync(EntityTypes.Organization, exact.OrganizationId, AteraTypes.System, AteraTypes.Customer, outcome.Record.ExternalId, LinkMethod.Automatic, null, ct)).IsSuccess)
                    {
                        autoLinked++;
                    }
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(AteraTypes.System, AteraTypes.Customer, scanStarted, ct);
            progress.Message = $"changed {progress.Changed}, auto-linked {autoLinked}, no longer in Atera {gone}";
        }, cancellationToken);
    }
}

public sealed class AteraContactSyncJob(
    IAteraClient client,
    ExternalRecordStore records,
    ExternalLinkService links,
    SyncRunner runner,
    ICustomersApi customers,
    TimeProvider timeProvider,
    IOptions<AteraOptions> options,
    ILogger<AteraContactSyncJob> logger)
{
    public const string JobId = "atera-contacts";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera contact sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var scanStarted = timeProvider.GetUtcNow();
            var changed = new List<(string ExternalId, string? Email)>();
            await foreach (var contact in client.GetContactsAsync(ct))
            {
                progress.Read++;
                var outcome = await records.UpsertAsync(AteraMapping.ToRecord(contact), ct);
                if (outcome.Changed)
                {
                    progress.Changed++;
                    changed.Add((outcome.Record.ExternalId, outcome.Record.Email));
                }
            }

            var byEmail = await customers.FindContactsByEmailAsync(changed.Where(c => c.Email != null).Select(c => c.Email!).ToList(), ct);
            int autoLinked = 0;
            foreach (var (externalId, email) in changed)
            {
                if (email is not null && byEmail.TryGetValue(email, out var contactId) &&
                    await links.FindByExternalAsync(AteraTypes.System, AteraTypes.Contact, externalId, ct) is null &&
                    (await links.LinkAsync(EntityTypes.Contact, contactId, AteraTypes.System, AteraTypes.Contact, externalId, LinkMethod.Automatic, null, ct)).IsSuccess)
                {
                    autoLinked++;
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(AteraTypes.System, AteraTypes.Contact, scanStarted, ct);
            progress.Message = $"changed {progress.Changed}, auto-linked {autoLinked}, no longer in Atera {gone}";
        }, cancellationToken);
    }
}

internal sealed class AteraCreateCustomerHandler(
    IAteraClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptions<AteraOptions> options) : IOutboundHandler
{
    public string System => AteraTypes.System;

    public string Operation => AteraTypes.CreateCustomer;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteEnabled)
        {
            throw new PermanentOutboundException("Writing to Atera is disabled (Integrations:Atera:WriteEnabled).");
        }

        if (await links.FindByEntityAsync(EntityTypes.Organization, operation.EntityId, System, AteraTypes.Customer, cancellationToken) is { } existing)
        {
            return new OutboundResult($"Already linked to Atera customer {existing.ExternalId}.");
        }

        var organization = await customers.GetOrganizationForSyncAsync(operation.EntityId, cancellationToken);
        if (organization is null || organization.IsDeleted)
        {
            throw new PermanentOutboundException("The organization no longer exists.");
        }

        // Atera has no external reference field: never retry a create blindly. A failed create becomes a dead letter for review.
        var id = await client.CreateCustomerAsync(AteraMapping.ToWrite(organization), cancellationToken);
        var externalId = id.ToString(CultureInfo.InvariantCulture);
        var link = await links.LinkAsync(EntityTypes.Organization, organization.Id, System, AteraTypes.Customer, externalId, LinkMethod.Exported, operation.RequestedBy, cancellationToken);
        if (!link.IsSuccess)
        {
            throw new PermanentOutboundException(link.Error!.Message);
        }

        if (await client.GetCustomerAsync(id, cancellationToken) is { } created)
        {
            await records.UpsertAsync(AteraMapping.ToRecord(created), cancellationToken);
        }

        return new OutboundResult($"Created Atera customer {id}.");
    }
}

internal sealed class AteraUpdateCustomerHandler(
    IAteraClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptions<AteraOptions> options) : IOutboundHandler
{
    public string System => AteraTypes.System;

    public string Operation => AteraTypes.UpdateCustomer;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        var link = await links.FindByEntityAsync(EntityTypes.Organization, operation.EntityId, System, AteraTypes.Customer, cancellationToken);
        var organization = await customers.GetOrganizationForSyncAsync(operation.EntityId, cancellationToken);
        if (!options.Value.WriteEnabled || link is null || organization is null || organization.IsDeleted)
        {
            return OutboundResult.NothingToDo;
        }

        if (options.Value.WriteAllowedCustomerIds.Count > 0 && !options.Value.WriteAllowedCustomerIds.Contains(link.ExternalId))
        {
            return new OutboundResult($"Atera customer {link.ExternalId} is not in WriteAllowedCustomerIds; skipped.");
        }

        var id = long.Parse(link.ExternalId, CultureInfo.InvariantCulture);
        var current = await client.GetCustomerAsync(id, cancellationToken)
                      ?? throw new PermanentOutboundException($"Customer {id} no longer exists in Atera.");
        var desired = AteraMapping.ToWrite(organization);
        var before = new AteraCustomerWrite(current.Name, current.BusinessNumber, current.Domain, current.Address, current.City, current.ZipCode, current.Country, current.Phone, current.Website);
        if (Normalize(before) == Normalize(desired))
        {
            return OutboundResult.NothingToDo;
        }

        await client.UpdateCustomerAsync(id, desired, cancellationToken);
        if (await client.GetCustomerAsync(id, cancellationToken) is { } updated)
        {
            await records.UpsertAsync(AteraMapping.ToRecord(updated), cancellationToken);
        }

        return new OutboundResult($"Updated Atera customer {id}.");
    }

    private static AteraCustomerWrite Normalize(AteraCustomerWrite w) => new(
        w.CustomerName.Trim(), Clean(w.BusinessNumber), Clean(w.Domain)?.ToLowerInvariant(), Clean(w.Address), Clean(w.City), Clean(w.ZipCode), Clean(w.Country), Clean(w.Phone), Clean(w.Website));

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

internal sealed class AteraOrganizationChangedHandler(
    ExternalLinkService links,
    OutboundQueue queue,
    IOptions<AteraOptions> options) : IDomainEventHandler<OrganizationUpdated>
{
    public async Task HandleAsync(OrganizationUpdated domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.WriteEnabled ||
            await links.FindByEntityAsync(EntityTypes.Organization, domainEvent.OrganizationId, AteraTypes.System, AteraTypes.Customer, cancellationToken) is null)
        {
            return;
        }

        await queue.EnqueueAsync(AteraTypes.System, AteraTypes.UpdateCustomer, EntityTypes.Organization, domainEvent.OrganizationId, null, cancellationToken);
    }
}

/// <summary>Queues an SLA push when a contract change may have changed the customer's service level.</summary>
internal sealed class AteraSlaChangedHandler(
    ExternalLinkService links,
    OutboundQueue queue,
    IOptions<AteraOptions> options) : IDomainEventHandler<OrganizationSlaChanged>
{
    public async Task HandleAsync(OrganizationSlaChanged domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.WriteEnabled || string.IsNullOrWhiteSpace(options.Value.SlaCustomFieldName) ||
            await links.FindByEntityAsync(EntityTypes.Organization, domainEvent.OrganizationId, AteraTypes.System, AteraTypes.Customer, cancellationToken) is null)
        {
            return;
        }

        await queue.EnqueueAsync(AteraTypes.System, AteraTypes.SetSla, EntityTypes.Organization, domainEvent.OrganizationId, null, cancellationToken);
    }
}

/// <summary>Writes the SLA level of the customer's active contract to the configured Atera custom field; clears it when there is none.</summary>
internal sealed class AteraSetSlaHandler(
    IAteraClient client,
    IContractsApi contracts,
    ExternalLinkService links,
    IOptions<AteraOptions> options) : IOutboundHandler
{
    public string System => AteraTypes.System;

    public string Operation => AteraTypes.SetSla;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        var field = options.Value.SlaCustomFieldName;
        var link = await links.FindByEntityAsync(EntityTypes.Organization, operation.EntityId, System, AteraTypes.Customer, cancellationToken);
        if (!options.Value.WriteEnabled || string.IsNullOrWhiteSpace(field) || link is null)
        {
            return OutboundResult.NothingToDo;
        }

        if (options.Value.WriteAllowedCustomerIds.Count > 0 && !options.Value.WriteAllowedCustomerIds.Contains(link.ExternalId))
        {
            return new OutboundResult($"Atera customer {link.ExternalId} is not in WriteAllowedCustomerIds; skipped.");
        }

        var id = long.Parse(link.ExternalId, CultureInfo.InvariantCulture);
        var sla = await contracts.GetOrganizationSlaAsync(operation.EntityId, cancellationToken);
        var desired = sla.AteraValue ?? string.Empty;
        var current = await client.GetCustomerFieldAsync(id, field, cancellationToken) ?? string.Empty;
        if (string.Equals(current.Trim(), desired, StringComparison.Ordinal))
        {
            return OutboundResult.NothingToDo;
        }

        await client.SetCustomerFieldAsync(id, field, desired, cancellationToken);
        return new OutboundResult(desired.Length == 0 ? $"Cleared {field} for Atera customer {id}." : $"Set {field} = {desired} for Atera customer {id}.");
    }
}
