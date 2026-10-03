using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

public static class PowerOfficeTypes
{
    public const string System = "poweroffice";
    public const string Customer = "Customer";
    public const string ContactPerson = "ContactPerson";
    public const string Product = "Product";
    public const string CreateCustomer = "create-customer";
    public const string UpdateCustomer = "update-customer";
    public const string SyncContactPerson = "sync-contact-person";
    public const string SalesOrder = "SalesOrder";
    public const string CreateSalesOrder = "create-sales-order";

    /// <summary>Outbound operations carry the billing basis id, which is not a link target of its own.</summary>
    public const string BillingBasis = "BillingBasis";
}

/// <summary>Mapping between PowerOffice models and CRM vocabulary.</summary>
internal static class PowerOfficeMapping
{
    public static ExternalRecordInput ToRecord(PoCustomer c) => new(
        PowerOfficeTypes.System, PowerOfficeTypes.Customer, c.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), c.DisplayName, c,
        c.LastChangedDateTimeOffset, Digits(c.OrganizationNumber), c.EmailAddress, c.PhoneNumber, Domain(c.WebsiteUrl), IsGone: c.IsArchived == true);

    public static ExternalRecordInput ToRecord(PoContactPerson p) => new(
        PowerOfficeTypes.System, PowerOfficeTypes.ContactPerson, ContactPersonId(p.ContactId, p.Id),
        string.Join(' ', new[] { p.FirstName, p.LastName }.Where(s => !string.IsNullOrWhiteSpace(s))) is { Length: > 0 } name ? name : p.EmailAddress ?? $"#{p.Id}",
        p, p.LastChangedDateTimeOffset, Email: p.EmailAddress, Phone: p.PhoneNumber,
        ParentExternalId: p.ContactId.ToString(System.Globalization.CultureInfo.InvariantCulture), IsGone: p.IsActive == false);

    public static ExternalRecordInput ToRecord(PoProduct p) => new(
        PowerOfficeTypes.System, PowerOfficeTypes.Product, p.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
        string.IsNullOrWhiteSpace(p.Code) ? p.Name ?? $"#{p.Id}" : $"{p.Code} {p.Name}", p, p.LastChangedDateTimeOffset, IsGone: p.IsArchived == true);

    public static string ContactPersonId(long contactId, long id) => $"{contactId}:{id}";

    public static ExternalOrganizationData ToOrganizationData(PoCustomer c)
    {
        var address = ToAddress(c.MailAddress);
        return new ExternalOrganizationData(
            c.DisplayName,
            Digits(c.OrganizationNumber),
            c.EmailAddress,
            c.PhoneNumber,
            c.WebsiteUrl,
            Domain(c.WebsiteUrl) is { } domain ? [domain] : [],
            null,
            address,
            ToBilling(c));
    }

    public static BillingData ToBilling(PoCustomer c) =>
        new(c.InvoiceEmailAddress, c.InvoiceDeliveryType is null ? null : string.Equals(c.InvoiceDeliveryType, "EHF", StringComparison.OrdinalIgnoreCase), ToAddress(c.MailAddress));

    public static AddressData? ToAddress(PoAddress? a) =>
        a is null || (string.IsNullOrWhiteSpace(a.AddressLine1) && string.IsNullOrWhiteSpace(a.ZipCode) && string.IsNullOrWhiteSpace(a.City))
            ? null
            : new AddressData(
                string.Join(", ", new[] { a.AddressLine1, a.AddressLine2 }.Where(s => !string.IsNullOrWhiteSpace(s))) is { Length: > 0 } street ? street : null,
                a.ZipCode, a.City, a.CountryCode);

    public static PoAddress? ToPoAddress(AddressData? a) =>
        a is null || (a.Street is null && a.PostalCode is null && a.City is null) ? null : new PoAddress(a.Street, null, a.PostalCode, a.City, a.CountryCode ?? "NO");

    public static string? Digits(string? value)
    {
        var digits = value is null ? string.Empty : new string(value.Where(char.IsAsciiDigit).ToArray());
        return digits.Length == 0 ? null : digits;
    }

    public static string? Domain(string? website)
    {
        if (string.IsNullOrWhiteSpace(website))
        {
            return null;
        }

        var text = website.Contains("://", StringComparison.Ordinal) ? website : "https://" + website;
        return Uri.TryCreate(text, UriKind.Absolute, out var uri) ? uri.Host.ToLowerInvariant().Replace("www.", string.Empty, StringComparison.Ordinal) : null;
    }
}

internal sealed class PowerOfficeAdapter(IOptions<PowerOfficeOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => PowerOfficeTypes.System;

    public bool IsEnabled => options.Value.IsConfigured;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } =
    [
        new(PowerOfficeTypes.System, PowerOfficeTypes.Customer, EntityTypes.Organization),
        new(PowerOfficeTypes.System, PowerOfficeTypes.ContactPerson, EntityTypes.Contact, PowerOfficeTypes.Customer),
        new(PowerOfficeTypes.System, PowerOfficeTypes.Product, EntityTypes.Product),
    ];

    public string? CreateOrganizationOperation => options.Value.WriteEnabled ? PowerOfficeTypes.CreateCustomer : null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == PowerOfficeTypes.Customer && ExternalRecordStore.Read<PoCustomer>(record) is { } customer
            ? PowerOfficeMapping.ToOrganizationData(customer)
            : null;

    public ExternalContactData? ToContactData(ExternalRecord record) =>
        record.ExternalType == PowerOfficeTypes.ContactPerson && ExternalRecordStore.Read<PoContactPerson>(record) is { } p
            ? new ExternalContactData(p.FirstName ?? string.Empty, p.LastName ?? string.Empty, p.EmailAddress, p.PhoneNumber, null, p.Title)
            : null;

    public ExternalProductData? ToProductData(ExternalRecord record) =>
        record.ExternalType == PowerOfficeTypes.Product && ExternalRecordStore.Read<PoProduct>(record) is { } p
            ? new ExternalProductData(p.Code, p.Name ?? p.Code ?? $"#{p.Id}", p.Description, p.UnitOfMeasureCode, p.UnitPrice, p.UnitCost)
            : null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var client = services.GetRequiredService<IPowerOfficeClient>();
            await using var enumerator = client.GetProductsAsync(DateTimeOffset.UtcNow, cancellationToken).GetAsyncEnumerator(cancellationToken);
            await enumerator.MoveNextAsync();
            return new ConnectionTestResult(true, $"Connected to PowerOffice Go ({options.Value.Environment}).");
        }
        catch (Exception ex) when (ex is HttpRequestException or PowerOfficeApiException)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }
}
