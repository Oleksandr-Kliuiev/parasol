using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crm.Integrations.PowerOffice;

// Subsets of the PowerOffice Go v2 OpenAPI models (swagger.poweroffice.net, Customers / Contact Persons / Products).
// Property names are PascalCase in the API.

public sealed record PoAddress(string? AddressLine1, string? AddressLine2, string? ZipCode, string? City, string? CountryCode);

public sealed record PoCustomer(
    long Id,
    long? Number,
    string? Name,
    string? LegalName,
    string? FirstName,
    string? LastName,
    bool? IsPerson,
    string? OrganizationNumber,
    string? EmailAddress,
    string? InvoiceEmailAddress,
    string? InvoiceDeliveryType,
    string? PhoneNumber,
    string? WebsiteUrl,
    PoAddress? MailAddress,
    bool? IsActive,
    bool? IsArchived,
    string? ExternalImportReference,
    DateTimeOffset LastChangedDateTimeOffset)
{
    public string DisplayName =>
        !string.IsNullOrWhiteSpace(Name) ? Name
        : string.Join(' ', new[] { FirstName, LastName }.Where(s => !string.IsNullOrWhiteSpace(s))) is { Length: > 0 } person ? person
        : $"#{Number ?? Id}";
}

public sealed record PoCustomerPost(
    string Name,
    string? OrganizationNumber,
    string? EmailAddress,
    string? PhoneNumber,
    string? WebsiteUrl,
    PoAddress? MailAddress,
    string? InvoiceEmailAddress,
    string? InvoiceDeliveryType,
    string ExternalImportReference,
    bool IsPerson = false);

public sealed record PoContactPerson(
    long Id,
    long ContactId,
    string? FirstName,
    string? LastName,
    string? EmailAddress,
    string? PhoneNumber,
    string? Title,
    bool? IsActive,
    bool? IsDefault,
    DateTimeOffset LastChangedDateTimeOffset,
    string? ExternalCode = null);

/// <summary>ContactPersonPostDto: FirstName and LastName are required.</summary>
public sealed record PoContactPersonPost(
    string FirstName,
    string LastName,
    string? EmailAddress,
    string? PhoneNumber,
    string? Title,
    string ExternalCode,
    bool IsActive = true);

public sealed record PoProduct(
    long Id,
    string? Code,
    string? Name,
    string? Description,
    string? ProductType,
    string? UnitOfMeasureCode,
    decimal? UnitPrice,
    decimal? UnitCost,
    bool? IsArchived,
    DateTimeOffset LastChangedDateTimeOffset);

/// <summary>SalesOrderDto (subset). Field names of the v2 API; anything the CRM does not send stays at the Go default.</summary>
public sealed record PoSalesOrder(
    long Id,
    long? OrderNo,
    long? CustomerId,
    long? CustomerNo,
    string? ExternalImportReference,
    string? CustomerReference,
    DateTimeOffset? OrderDate,
    string? Status,
    decimal? TotalAmount,
    DateTimeOffset? LastChangedDateTimeOffset)
{
    public string Number => (OrderNo ?? Id).ToString(System.Globalization.CultureInfo.InvariantCulture);
}

public sealed record PoSalesOrderLinePost(
    string? ProductCode,
    string Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal? DiscountPercent,
    int? SortOrder);

public sealed record PoSalesOrderPost(
    long CustomerId,
    DateTimeOffset OrderDate,
    string ExternalImportReference,
    string? CustomerReference,
    IReadOnlyList<PoSalesOrderLinePost> Lines);

/// <summary>RFC 6902 operation as accepted by PowerOffice PATCH endpoints (application/json-patch+json).</summary>
public sealed record PatchOperation(
    [property: JsonPropertyName("op")] string Op,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("value")] object? Value);

internal sealed record TokenResponse(
    [property: JsonPropertyName("access_token")] string AccessToken,
    [property: JsonPropertyName("expires_in")] int? ExpiresIn);

internal static class PoJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = null,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}
