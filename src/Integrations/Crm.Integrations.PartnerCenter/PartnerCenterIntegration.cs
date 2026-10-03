using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Licensing.Contracts;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

public static class PartnerCenterTypes
{
    public const string System = "partnercenter";
    public const string Customer = "Customer";
}

internal static class PartnerCenterMapping
{
    public static ExternalRecordInput ToRecord(PcCustomer customer) => new(
        PartnerCenterTypes.System,
        PartnerCenterTypes.Customer,
        customer.CustomerId,
        customer.Name,
        customer,
        null,
        customer.OrganizationNumber,
        null,
        null,
        customer.Domain?.ToLowerInvariant());

    public static ExternalOrganizationData ToOrganizationData(PcCustomer customer) => new(
        customer.Name,
        customer.OrganizationNumber,
        null,
        null,
        customer.Domain is null ? null : $"https://{customer.Domain}",
        customer.Domain is null ? [] : [customer.Domain.ToLowerInvariant()],
        null,
        null,
        null);
}

/// <summary>Partner Center is read-only for the CRM: CSP customers are mapped to organizations, subscriptions mirror into Licensing.</summary>
internal sealed class PartnerCenterAdapter(IOptions<PartnerCenterOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => PartnerCenterTypes.System;

    public bool IsEnabled => options.Value.IsConfigured;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } = [new(PartnerCenterTypes.System, PartnerCenterTypes.Customer, EntityTypes.Organization)];

    public string? CreateOrganizationOperation => null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == PartnerCenterTypes.Customer && ExternalRecordStore.Read<PcCustomer>(record) is { } customer
            ? PartnerCenterMapping.ToOrganizationData(customer)
            : null;

    public ExternalContactData? ToContactData(ExternalRecord record) => null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var client = services.GetRequiredService<IPartnerCenterClient>();
            await using var enumerator = client.GetCustomersAsync(cancellationToken).GetAsyncEnumerator(cancellationToken);
            await enumerator.MoveNextAsync();
            return new ConnectionTestResult(true, "Connected to Partner Center.");
        }
        catch (Exception ex) when (ex is HttpRequestException or PartnerCenterApiException)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }
}

/// <summary>CSP customers (BR-LIC-01): stored as external records and auto-linked only on an exact organization number match.</summary>
public sealed class PartnerCenterCustomerSyncJob(
    IPartnerCenterClient client,
    ExternalRecordStore records,
    ExternalLinkService links,
    SyncRunner runner,
    ICustomersApi customers,
    TimeProvider time,
    IOptions<PartnerCenterOptions> options,
    ILogger<PartnerCenterCustomerSyncJob> logger)
{
    public const string JobId = "partnercenter-customers";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Partner Center customer sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PartnerCenterTypes.System, JobId, async (progress, ct) =>
        {
            var scanStarted = time.GetUtcNow();
            IOrganizationMatcher? matcher = null;
            var autoLinked = 0;
            await foreach (var customer in client.GetCustomersAsync(ct))
            {
                progress.Read++;
                var outcome = await records.UpsertAsync(PartnerCenterMapping.ToRecord(customer), ct);
                if (!outcome.Changed)
                {
                    continue;
                }

                progress.Changed++;
                if (customer.OrganizationNumber is not null &&
                    await links.FindByExternalAsync(PartnerCenterTypes.System, PartnerCenterTypes.Customer, customer.CustomerId, ct) is null)
                {
                    matcher ??= await customers.CreateMatcherAsync(ct);
                    if (matcher.Match(PartnerCenterMapping.ToOrganizationData(customer)) is [{ IsExact: true } exact] &&
                        (await links.LinkAsync(EntityTypes.Organization, exact.OrganizationId, PartnerCenterTypes.System, PartnerCenterTypes.Customer,
                            customer.CustomerId, LinkMethod.Automatic, null, ct)).IsSuccess)
                    {
                        autoLinked++;
                    }
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(PartnerCenterTypes.System, PartnerCenterTypes.Customer, scanStarted, ct);
            progress.Message = $"changed {progress.Changed}, auto-linked {autoLinked}, no longer in Partner Center {gone}";
        }, cancellationToken);
    }
}

/// <summary>CSP subscriptions (FR-LIC-01): read per customer and mirrored into the Licensing module, with the CRM organization when it is mapped.</summary>
public sealed class PartnerCenterSubscriptionSyncJob(
    IPartnerCenterClient client,
    IntegrationDbContext db,
    ILicensingApi licensing,
    SyncRunner runner,
    IOptions<PartnerCenterOptions> options,
    ILogger<PartnerCenterSubscriptionSyncJob> logger)
{
    public const string JobId = "partnercenter-subscriptions";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Partner Center subscription sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PartnerCenterTypes.System, JobId, async (progress, ct) =>
        {
            var links = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync(
                db.ExternalLinks.Where(l => l.System == PartnerCenterTypes.System && l.ExternalType == PartnerCenterTypes.Customer)
                    .Select(l => new { l.ExternalId, l.EntityId }),
                ct);
            var byCustomer = links.ToDictionary(l => l.ExternalId, l => l.EntityId, StringComparer.Ordinal);

            var subscriptions = new List<ExternalSubscription>();
            await foreach (var customer in client.GetCustomersAsync(ct))
            {
                foreach (var subscription in await client.GetSubscriptionsAsync(customer, ct))
                {
                    progress.Read++;
                    subscriptions.Add(byCustomer.TryGetValue(customer.CustomerId, out var organizationId)
                        ? subscription with { OrganizationId = organizationId }
                        : subscription);
                }
            }

            var result = await licensing.UpsertAsync(subscriptions, ct);
            progress.Changed = result.Created + result.Updated;
            progress.Message = string.Create(CultureInfo.InvariantCulture,
                $"new {result.Created}, updated {result.Updated}, unchanged {result.Unchanged}, without organization {result.WithoutOrganization}");
        }, cancellationToken);
    }
}
