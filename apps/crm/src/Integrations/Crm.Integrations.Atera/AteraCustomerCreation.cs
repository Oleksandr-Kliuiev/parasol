using System.Globalization;
using System.Net;
using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>The customer actions of Atera (M43): the customer created from the "Connect services" wizard.</summary>
public static class AteraCustomerKinds
{
    public const string Create = "customer.create";

    public static readonly string[] All = [Create];
}

/// <summary>
/// Creates the customer in Atera from the CRM organization (<c>customer.create</c>, M43): name, organization number, domain, address,
/// phone and website, as the mapping screen's export sends them. Atera keeps no reference of ours, so our key is the organization
/// number (or, without one, the exact name); the request is journaled with the export's kind, so neither path creates the customer twice.
/// </summary>
internal sealed class AteraCreateCustomerAction(
    IAteraClient client, IOptionsMonitor<AteraOptions> options, ICustomersApi customers, IntegrationDbContext db, ExternalLinkService links, ExternalRecordStore records, IExternalEffectJournal journal)
    : CustomerCreationAction(customers, db, links, records, journal)
{
    public override string System => AteraTypes.System;

    public override string Kind => AteraCustomerKinds.Create;

    protected override string VendorName => "Atera";

    public override string ExternalType => AteraTypes.Customer;

    protected override string EffectKind => AteraCreateCustomerHandler.CustomerEffect;

    public override string? ConsoleUrl => Link(options.CurrentValue.ConsoleUrl);

    protected override CustomerCreationPlan Prepare(OrganizationSyncView organization, JsonElement parameters)
    {
        var write = AteraMapping.ToWrite(organization);
        // Without an organization number, the exact name is our key at Atera, which the preview says.
        return new CustomerCreationPlan("{}",
        [
            AteraMapping.OrgNumber(write.BusinessNumber) is { } number
                ? Effect("VND_EFFECT_ATERA_CUSTOMER_CREATE", ("name", write.CustomerName), ("orgNumber", number))
                : Effect("VND_EFFECT_ATERA_CUSTOMER_CREATE_BY_NAME", ("name", write.CustomerName)),
            Effect("VND_EFFECT_CUSTOMER_LINKED", ("vendor", "Atera")),
        ]);
    }

    protected override IQueryable<ExternalRecord> WithKey(IQueryable<ExternalRecord> saved, OrganizationSyncView organization, JsonElement parameters)
    {
        var number = AteraMapping.OrgNumber(organization.OrgNumber);
        var name = organization.Name.Trim();
        return number is not null ? saved.Where(r => r.OrgNumber == number) : saved.Where(r => r.DisplayName == name);
    }

    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct)
    {
        var number = AteraMapping.OrgNumber(organization.OrgNumber);
        var name = organization.Name.Trim();
        var found = new List<VendorCustomerRecord>();
        await foreach (var customer in client.GetCustomersAsync(ct))
        {
            var same = number is not null
                ? AteraMapping.OrgNumber(customer.BusinessNumber) == number
                : string.Equals(customer.Name.Trim(), name, StringComparison.OrdinalIgnoreCase);
            if (same)
            {
                found.Add(Record(customer));
            }
        }

        return found;
    }

    /// <summary>
    /// A customer someone made in Atera without an organization number, named like ours: the key search cannot find it, and it is not
    /// created a second time. A namesake with another organization number is another company.
    /// </summary>
    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindByNameAsync(OrganizationSyncView organization, CancellationToken ct)
    {
        if (AteraMapping.OrgNumber(organization.OrgNumber) is null)
        {
            return [];
        }

        var name = organization.Name.Trim();
        var found = new List<VendorCustomerRecord>();
        await foreach (var customer in client.GetCustomersAsync(ct))
        {
            if (AteraMapping.OrgNumber(customer.BusinessNumber) is null && string.Equals(customer.Name.Trim(), name, StringComparison.OrdinalIgnoreCase))
            {
                found.Add(Record(customer));
            }
        }

        return found;
    }

    protected override async Task<VendorCustomerRecord> CreateAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct)
    {
        var write = AteraMapping.ToWrite(organization);
        var id = await client.CreateCustomerAsync(write, ct);
        // Atera answers a create with the new id only. The record is read back for the mapping screen; when that read fails in any way
        // (a 404 while Atera has not listed it yet), what was sent stands in until the next customer read stores Atera's own copy: the
        // id is known, so the read never decides the create's outcome.
        AteraCustomer? created = null;
        try
        {
            created = await client.GetCustomerAsync(id, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
        }

        return Record(created ?? new AteraCustomer(id, write.CustomerName, write.BusinessNumber, write.Domain, write.Address, write.City, write.ZipCode,
            write.Country, write.Phone, write.Website, null));
    }

    protected override VendorFailure Classify(Exception exception, CancellationToken ct) => exception switch
    {
        AteraApiException { Status: HttpStatusCode.TooManyRequests } => VendorFailure.Busy,
        AteraApiException refused when AteraCreateTicketHandler.IsRejection(refused.Status) => VendorFailure.Refused,
        _ => VendorFailure.Unknown,
    };

    protected override bool IsReadFailure(Exception exception, CancellationToken ct) => AteraConversationReader.IsReadFailure(exception, ct);

    private static VendorCustomerRecord Record(AteraCustomer customer) =>
        new(customer.CustomerId.ToString(CultureInfo.InvariantCulture), customer.Name, AteraMapping.ToRecord(customer));
}
