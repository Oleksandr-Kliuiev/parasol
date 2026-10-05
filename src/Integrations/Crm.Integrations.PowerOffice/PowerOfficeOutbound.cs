using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>Fields the CRM owns in PowerOffice (docs/04-data-model.md §3); billing fields only when the CRM is the billing master.</summary>
internal static class CustomerPatchBuilder
{
    public static IReadOnlyList<PatchOperation> Build(PoCustomer current, OrganizationSyncView organization, BillingDetailsMaster master)
    {
        var ops = new List<PatchOperation>();
        foreach (var field in Fields(current, organization, master))
        {
            // An empty CRM value never clears what PowerOffice holds: the data may have been typed in Go, and a clear cannot be undone.
            if (Normalize(field.Desired) is not null && !string.Equals(Normalize(field.Live), Normalize(field.Desired), StringComparison.Ordinal))
            {
                ops.Add(new PatchOperation("replace", field.Path, field.Desired));
            }
        }

        if (master == BillingDetailsMaster.Crm)
        {
            var isEhf = string.Equals(current.InvoiceDeliveryType, "EHF", StringComparison.OrdinalIgnoreCase);
            if (organization.Billing.EhfEnabled == true && !isEhf)
            {
                ops.Add(new PatchOperation("replace", "/InvoiceDeliveryType", "EHF"));
            }
            else if (organization.Billing.EhfEnabled == false && isEhf)
            {
                ops.Add(new PatchOperation("replace", "/InvoiceDeliveryType", "PdfByEmail"));
            }

            var desiredAddress = PowerOfficeMapping.ToPoAddress(BillingAddressOf(organization));
            if (desiredAddress is not null && !SameAddress(current.MailAddress, desiredAddress))
            {
                ops.Add(new PatchOperation("replace", "/MailAddress", desiredAddress));
            }
        }

        return ops;
    }

    private readonly record struct Field(string Path, string? Live, string? Desired);

    /// <summary>The plain text fields the CRM owns, with the live value in PowerOffice next to what the CRM wants there.</summary>
    private static IEnumerable<Field> Fields(PoCustomer current, OrganizationSyncView organization, BillingDetailsMaster master)
    {
        yield return new Field("/Name", current.Name, organization.Name);
        yield return new Field("/OrganizationNumber", PowerOfficeMapping.Digits(current.OrganizationNumber), organization.OrgNumber);
        yield return new Field("/EmailAddress", current.EmailAddress?.ToLowerInvariant(), organization.Email);
        yield return new Field("/PhoneNumber", current.PhoneNumber, organization.Phone);
        yield return new Field("/WebsiteUrl", current.WebsiteUrl, organization.Website);
        if (master == BillingDetailsMaster.Crm)
        {
            yield return new Field("/InvoiceEmailAddress", current.InvoiceEmailAddress?.ToLowerInvariant(), organization.Billing.InvoiceEmail);
        }
    }

    /// <summary>
    /// CRM-owned fields whose live value differs from both what the CRM wants and what the CRM last saw in PowerOffice (the
    /// stored copy, which a push refreshes): someone edited them in Go. Only field names are returned, never values.
    /// </summary>
    public static IReadOnlyList<string> Discrepancies(PoCustomer live, PoCustomer lastKnown, OrganizationSyncView organization, BillingDetailsMaster master)
    {
        var known = Fields(lastKnown, organization, master).ToDictionary(f => f.Path, f => f.Live, StringComparer.Ordinal);
        return Fields(live, organization, master)
            .Where(f => Normalize(f.Live) != Normalize(known[f.Path]) && Normalize(f.Live) != Normalize(f.Desired))
            .Select(f => f.Path.TrimStart('/'))
            .ToList();
    }

    /// <summary>PowerOffice has one mail address: the billing address if set, otherwise the postal address.</summary>
    public static AddressData BillingAddressOf(OrganizationSyncView organization) =>
        organization.Billing.Address is { Street: not null } or { City: not null } ? organization.Billing.Address! : organization.PostalAddress;

    private static bool SameAddress(PoAddress? current, PoAddress desired) =>
        current is not null &&
        Normalize(PowerOfficeMapping.ToAddress(current)?.Street) == Normalize(desired.AddressLine1) &&
        Normalize(current.ZipCode) == Normalize(desired.ZipCode) &&
        Normalize(current.City)?.ToUpperInvariant() == Normalize(desired.City)?.ToUpperInvariant();

    private static string? Normalize(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

internal sealed class PowerOfficeCreateCustomerHandler(
    IPowerOfficeClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptions<PowerOfficeOptions> options) : IOutboundHandler
{
    public string System => PowerOfficeTypes.System;

    public string Operation => PowerOfficeTypes.CreateCustomer;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteEnabled)
        {
            throw new PermanentOutboundException("Writing to PowerOffice is disabled (Integrations:PowerOffice:WriteEnabled).");
        }

        if (await links.FindByEntityAsync(EntityTypes.Organization, operation.EntityId, System, PowerOfficeTypes.Customer, cancellationToken) is { } existingLink)
        {
            return new OutboundResult($"Already linked to customer {existingLink.ExternalId}.");
        }

        var organization = await customers.GetOrganizationForSyncAsync(operation.EntityId, cancellationToken);
        if (organization is null || organization.IsDeleted)
        {
            throw new PermanentOutboundException("The organization no longer exists.");
        }

        var reference = $"crm:{organization.Id}";
        // Idempotency: a previous attempt may have created the customer before failing, or it may already exist in Go.
        var customer = await client.FindCustomerAsync(reference, organization.OrgNumber, cancellationToken);
        var created = customer is null;
        if (customer is null)
        {
            var crmOwnsBilling = customers.BillingDetailsMaster == BillingDetailsMaster.Crm;
            customer = await client.CreateCustomerAsync(new PoCustomerPost(
                organization.Name,
                organization.OrgNumber,
                organization.Email,
                organization.Phone,
                organization.Website,
                PowerOfficeMapping.ToPoAddress(CustomerPatchBuilder.BillingAddressOf(organization)),
                crmOwnsBilling ? organization.Billing.InvoiceEmail : null,
                crmOwnsBilling && organization.Billing.EhfEnabled == true ? "EHF" : null,
                reference), cancellationToken);
        }

        var id = customer.Id.ToString(CultureInfo.InvariantCulture);
        var link = await links.LinkAsync(EntityTypes.Organization, organization.Id, System, PowerOfficeTypes.Customer, id,
            created ? LinkMethod.Exported : LinkMethod.Automatic, operation.RequestedBy, cancellationToken);
        if (!link.IsSuccess)
        {
            throw new PermanentOutboundException(link.Error!.Message);
        }

        await records.UpsertAsync(PowerOfficeMapping.ToRecord(customer), cancellationToken);
        return new OutboundResult(created ? $"Created customer {customer.Number ?? customer.Id}." : $"Linked existing customer {customer.Number ?? customer.Id}.");
    }
}

internal sealed class PowerOfficeUpdateCustomerHandler(
    IPowerOfficeClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeUpdateCustomerHandler> logger) : IOutboundHandler
{
    public string System => PowerOfficeTypes.System;

    public string Operation => PowerOfficeTypes.UpdateCustomer;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteEnabled)
        {
            return new OutboundResult("Writing to PowerOffice is disabled.");
        }

        var link = await links.FindByEntityAsync(EntityTypes.Organization, operation.EntityId, System, PowerOfficeTypes.Customer, cancellationToken);
        var organization = await customers.GetOrganizationForSyncAsync(operation.EntityId, cancellationToken);
        if (link is null || organization is null || organization.IsDeleted)
        {
            return OutboundResult.NothingToDo;
        }

        var id = long.Parse(link.ExternalId, CultureInfo.InvariantCulture);
        // Compare with the live customer, not the stored copy: someone may have edited it in Go since the last sync.
        var current = await client.GetCustomerAsync(id, cancellationToken)
                      ?? throw new PermanentOutboundException($"Customer {id} no longer exists in PowerOffice.");
        var ops = CustomerPatchBuilder.Build(current, organization, customers.BillingDetailsMaster);
        if (await records.FindAsync(PowerOfficeTypes.System, PowerOfficeTypes.Customer, link.ExternalId, cancellationToken) is { } stored &&
            ExternalRecordStore.Read<PoCustomer>(stored) is { } lastKnown)
        {
            var edited = CustomerPatchBuilder.Discrepancies(current, lastKnown, organization, customers.BillingDetailsMaster);
            if (edited.Count > 0)
            {
                logger.LogWarning("PowerOffice customer {CustomerId} was edited outside the CRM in CRM-owned fields {Fields}; the CRM value is pushed over it.",
                    id, string.Join(",", edited));
            }
        }

        if (ops.Count == 0)
        {
            return OutboundResult.NothingToDo;
        }

        var updated = await client.PatchCustomerAsync(id, ops, cancellationToken);
        await records.UpsertAsync(PowerOfficeMapping.ToRecord(updated), cancellationToken);
        return new OutboundResult($"Updated {string.Join(", ", ops.Select(o => o.Path.TrimStart('/')))}.");
    }
}

/// <summary>Queues a PowerOffice update when a linked organization changes in the CRM.</summary>
internal sealed class PowerOfficeOrganizationChangedHandler(
    ExternalLinkService links,
    OutboundQueue queue,
    IOptions<PowerOfficeOptions> options) : IDomainEventHandler<OrganizationUpdated>
{
    public async Task HandleAsync(OrganizationUpdated domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured || !options.Value.WriteEnabled ||
            await links.FindByEntityAsync(EntityTypes.Organization, domainEvent.OrganizationId, PowerOfficeTypes.System, PowerOfficeTypes.Customer, cancellationToken) is null)
        {
            return;
        }

        await queue.EnqueueAsync(PowerOfficeTypes.System, PowerOfficeTypes.UpdateCustomer, EntityTypes.Organization, domainEvent.OrganizationId, null, cancellationToken);
    }
}

/// <summary>
/// Contacts are mastered in the CRM (docs/04 §3). A contact already linked to a PowerOffice contact person is kept up to date;
/// a billing contact of an organization linked to a PowerOffice customer is created there. PowerOffice links one person to one
/// customer, so only the first such affiliation (primary first) is exported.
/// </summary>
internal sealed class PowerOfficeSyncContactPersonHandler(
    IPowerOfficeClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptions<PowerOfficeOptions> options) : IOutboundHandler
{
    public string System => PowerOfficeTypes.System;

    public string Operation => PowerOfficeTypes.SyncContactPerson;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteEnabled)
        {
            return new OutboundResult("Writing to PowerOffice is disabled.");
        }

        var contact = await customers.GetContactForSyncAsync(operation.EntityId, cancellationToken);
        if (contact is null || contact.IsDeleted)
        {
            return OutboundResult.NothingToDo;
        }

        var link = await links.FindByEntityAsync(EntityTypes.Contact, contact.Id, System, PowerOfficeTypes.ContactPerson, cancellationToken);
        if (link is not null)
        {
            return await UpdateAsync(contact, link.ExternalId, cancellationToken);
        }

        foreach (var affiliation in contact.Affiliations.Where(a => a is { IsBilling: true, IsActive: true }))
        {
            if (await links.FindByEntityAsync(EntityTypes.Organization, affiliation.OrganizationId, System, PowerOfficeTypes.Customer, cancellationToken) is { } customerLink)
            {
                return await CreateAsync(contact, affiliation, long.Parse(customerLink.ExternalId, CultureInfo.InvariantCulture), operation.RequestedBy, cancellationToken);
            }
        }

        return OutboundResult.NothingToDo;
    }

    private async Task<OutboundResult> CreateAsync(ContactSyncView contact, ContactAffiliationView affiliation, long customerId, Guid? requestedBy, CancellationToken cancellationToken)
    {
        var externalCode = $"crm:{contact.Id}";
        // Idempotency: a previous attempt may have created the person before failing.
        var person = await client.FindContactPersonAsync(externalCode, cancellationToken);
        var created = person is null;
        person ??= await client.CreateContactPersonAsync(customerId, new PoContactPersonPost(
            NameOrDash(contact.FirstName), NameOrDash(contact.LastName), contact.Email, contact.Phone ?? contact.MobilePhone, affiliation.Title, externalCode), cancellationToken);

        var externalId = PowerOfficeMapping.ContactPersonId(person.ContactId == 0 ? customerId : person.ContactId, person.Id);
        var link = await links.LinkAsync(EntityTypes.Contact, contact.Id, System, PowerOfficeTypes.ContactPerson, externalId,
            created ? LinkMethod.Exported : LinkMethod.Automatic, requestedBy, cancellationToken);
        if (!link.IsSuccess)
        {
            throw new PermanentOutboundException(link.Error!.Message);
        }

        await records.UpsertAsync(PowerOfficeMapping.ToRecord(person with { ContactId = person.ContactId == 0 ? customerId : person.ContactId }), cancellationToken);
        return new OutboundResult(created ? $"Created contact person {externalId}." : $"Linked existing contact person {externalId}.");
    }

    private async Task<OutboundResult> UpdateAsync(ContactSyncView contact, string externalId, CancellationToken cancellationToken)
    {
        var parts = externalId.Split(':');
        var customerId = long.Parse(parts[0], CultureInfo.InvariantCulture);
        var id = long.Parse(parts[1], CultureInfo.InvariantCulture);
        var current = await client.GetContactPersonAsync(customerId, id, cancellationToken)
                      ?? throw new PermanentOutboundException($"Contact person {externalId} no longer exists in PowerOffice.");

        var ops = new List<PatchOperation>();
        void Compare(string path, string? currentValue, string? desired)
        {
            // An empty CRM value never clears what PowerOffice holds.
            if (Clean(desired) is not null && !string.Equals(Clean(currentValue), Clean(desired), StringComparison.Ordinal))
            {
                ops.Add(new PatchOperation("replace", path, Clean(desired)));
            }
        }

        Compare("/FirstName", current.FirstName, NameOrDash(contact.FirstName));
        Compare("/LastName", current.LastName, NameOrDash(contact.LastName));
        Compare("/EmailAddress", current.EmailAddress?.ToLowerInvariant(), contact.Email);
        Compare("/PhoneNumber", current.PhoneNumber, contact.Phone ?? contact.MobilePhone);
        if (ops.Count == 0)
        {
            return OutboundResult.NothingToDo;
        }

        var updated = await client.PatchContactPersonAsync(customerId, id, ops, cancellationToken);
        await records.UpsertAsync(PowerOfficeMapping.ToRecord(updated), cancellationToken);
        return new OutboundResult($"Updated {string.Join(", ", ops.Select(o => o.Path.TrimStart('/')))}.");
    }

    // PowerOffice requires both names; the CRM requires only one of them.
    private static string NameOrDash(string value) => string.IsNullOrWhiteSpace(value) ? "-" : value.Trim();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

/// <summary>Queues a contact person sync when a person or their role at an organization changes.</summary>
internal sealed class PowerOfficeContactChangedHandler(OutboundQueue queue, IOptions<PowerOfficeOptions> options) :
    IDomainEventHandler<ContactUpdated>,
    IDomainEventHandler<ContactAffiliationChanged>
{
    public Task HandleAsync(ContactUpdated domainEvent, CancellationToken cancellationToken) => EnqueueAsync(domainEvent.ContactId, cancellationToken);

    public Task HandleAsync(ContactAffiliationChanged domainEvent, CancellationToken cancellationToken) => EnqueueAsync(domainEvent.ContactId, cancellationToken);

    // The handler decides whether there is anything to do, so no lookups here.
    private async Task EnqueueAsync(Guid contactId, CancellationToken cancellationToken)
    {
        if (options.Value.IsConfigured && options.Value.WriteEnabled)
        {
            await queue.EnqueueAsync(PowerOfficeTypes.System, PowerOfficeTypes.SyncContactPerson, EntityTypes.Contact, contactId, null, cancellationToken);
        }
    }
}
