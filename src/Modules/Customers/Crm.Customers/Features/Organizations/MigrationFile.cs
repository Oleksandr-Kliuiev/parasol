using System.Globalization;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.SharedKernel.Text;

namespace Crm.Customers.Features.Organizations;

/// <summary>
/// One row of a migration file after reading and checking it on its own (DEV-20): values normalised, and the first reason
/// the row cannot be imported, if any. Checks that need the whole file or the CRM (duplicates, owners, references) come after.
/// </summary>
internal sealed class MigrationRowData
{
    public int Line { get; init; }
    public string? Name { get; init; }
    public string? OrgNumber { get; init; }
    public OrganizationStatus? Status { get; init; }
    public string? Email { get; init; }
    public string? Phone { get; init; }
    public string? Website { get; init; }
    public string? Domain { get; init; }
    public string? InvoiceEmail { get; init; }
    public bool? Ehf { get; init; }
    public string? Street { get; init; }
    public string? PostalCode { get; init; }
    public string? City { get; init; }
    public string? ContactFirstName { get; init; }
    public string? ContactLastName { get; init; }
    public string? ContactEmail { get; init; }
    public string? ContactPhone { get; init; }
    public string? ContactTitle { get; init; }
    public ContactRoles ContactRoles { get; init; }
    public string? OwnerEmail { get; init; }
    public string? ExternalSystem { get; init; }
    public string? ExternalId { get; init; }
    public string? ParentOrgNumber { get; init; }
    public DateOnly? ContractStart { get; init; }
    public DateOnly? ContractEnd { get; init; }
    public string? Currency { get; init; }
    public decimal? VatRate { get; init; }
    public string? ProductSku { get; init; }

    /// <summary>The CRM user the owner e-mail names, once resolved.</summary>
    public Guid? OwnerId { get; set; }

    /// <summary>The reason this row is rejected; null when it can be imported.</summary>
    public string? RejectCode { get; set; }

    public List<string> Warnings { get; } = [];

    public string? SourceKey { get; set; }

    public bool HasContact => ContactFirstName is not null || ContactLastName is not null || ContactEmail is not null;

    public bool Rejected => RejectCode is not null;

    public void Reject(string code) => RejectCode ??= code;
}

/// <summary>Reads a migration file into rows and checks each on its own. Pure: no database, no clock.</summary>
internal static class MigrationFile
{
    public static readonly decimal[] VatRates = [0m, 12m, 15m, 25m];

    /// <summary>The columns that are checked and reported but not written anywhere (DEV-20: validated, not imported).</summary>
    public static readonly string[] ValidatedColumns =
        ["externalsystem", "externalid", "parentorgnumber", "contractstart", "contractend", "currency", "vatrate", "productsku"];

    public static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["name"] = "name",
        ["navn"] = "name",
        ["kunde"] = "name",
        ["kundenavn"] = "name",
        ["customer"] = "name",
        ["organizationname"] = "name",
        ["orgnumber"] = "orgnumber",
        ["orgnr"] = "orgnumber",
        ["organisasjonsnummer"] = "orgnumber",
        ["organizationnumber"] = "orgnumber",
        ["status"] = "status",
        ["email"] = "email",
        ["epost"] = "email",
        ["phone"] = "phone",
        ["telefon"] = "phone",
        ["website"] = "website",
        ["nettside"] = "website",
        ["hjemmeside"] = "website",
        ["domain"] = "domain",
        ["domene"] = "domain",
        ["invoiceemail"] = "invoiceemail",
        ["fakturaepost"] = "invoiceemail",
        ["ehf"] = "ehf",
        ["street"] = "street",
        ["adresse"] = "street",
        ["gateadresse"] = "street",
        ["postalcode"] = "postalcode",
        ["postnummer"] = "postalcode",
        ["city"] = "city",
        ["poststed"] = "city",
        ["contactfirstname"] = "contactfirstname",
        ["fornavn"] = "contactfirstname",
        ["contactlastname"] = "contactlastname",
        ["etternavn"] = "contactlastname",
        ["contactemail"] = "contactemail",
        ["kontaktepost"] = "contactemail",
        ["contactphone"] = "contactphone",
        ["kontakttelefon"] = "contactphone",
        ["contactrole"] = "contactrole",
        ["kontaktrolle"] = "contactrole",
        ["contacttitle"] = "contacttitle",
        ["stilling"] = "contacttitle",
        ["owner"] = "owner",
        ["eier"] = "owner",
        ["kundeansvarlig"] = "owner",
        ["accountmanager"] = "owner",
        ["externalsystem"] = "externalsystem",
        ["kildesystem"] = "externalsystem",
        ["sourcesystem"] = "externalsystem",
        ["externalid"] = "externalid",
        ["kildeid"] = "externalid",
        ["sourceid"] = "externalid",
        ["parentorgnumber"] = "parentorgnumber",
        ["parentorgnr"] = "parentorgnumber",
        ["morselskap"] = "parentorgnumber",
        ["contractstart"] = "contractstart",
        ["avtalestart"] = "contractstart",
        ["contractend"] = "contractend",
        ["avtaleslutt"] = "contractend",
        ["currency"] = "currency",
        ["valuta"] = "currency",
        ["vatrate"] = "vatrate",
        ["mva"] = "vatrate",
        ["mvasats"] = "vatrate",
        ["productsku"] = "productsku",
        ["sku"] = "productsku",
    };

    private static readonly Dictionary<string, OrganizationStatus> Statuses = new(StringComparer.OrdinalIgnoreCase)
    {
        ["lead"] = OrganizationStatus.Lead,
        ["prospect"] = OrganizationStatus.Prospect,
        ["prospekt"] = OrganizationStatus.Prospect,
        ["customer"] = OrganizationStatus.Customer,
        ["kunde"] = OrganizationStatus.Customer,
        ["former"] = OrganizationStatus.Former,
        ["tidligere"] = OrganizationStatus.Former,
        ["partner"] = OrganizationStatus.Partner,
    };

    public static MigrationRowData ReadRow(CsvTable table, int row, string sourceSha256, bool hasEncodingProblem)
    {
        string? V(string column) => table.Value(row, column);

        var rawNumber = V("orgnumber");
        var number = rawNumber is not null && OrgNumber.IsValid(rawNumber) ? OrgNumber.Normalize(rawNumber) : null;
        var rawDomain = V("domain");
        var domain = NormalizeDomain(rawDomain);
        var rawStatus = V("status");
        OrganizationStatus? status = rawStatus is not null && Statuses.TryGetValue(rawStatus, out var parsedStatus) ? parsedStatus : null;
        var rawParent = V("parentorgnumber");
        var parent = rawParent is not null && OrgNumber.IsValid(rawParent) ? OrgNumber.Normalize(rawParent) : null;
        var start = ReadDate(V("contractstart"), out var startCode);
        var end = ReadDate(V("contractend"), out var endCode);
        var rawVat = V("vatrate");
        var vat = rawVat is null ? null : CsvTable.Decimal(rawVat.Replace("%", string.Empty, StringComparison.Ordinal));
        var currency = V("currency")?.ToUpperInvariant();

        var data = new MigrationRowData
        {
            Line = table.Line(row),
            Name = V("name"),
            OrgNumber = number,
            Status = status,
            Email = V("email")?.ToLowerInvariant(),
            Phone = V("phone"),
            Website = V("website"),
            Domain = domain,
            InvoiceEmail = V("invoiceemail")?.ToLowerInvariant(),
            Ehf = ReadFlag(V("ehf")),
            Street = V("street"),
            PostalCode = V("postalcode"),
            City = V("city"),
            ContactFirstName = V("contactfirstname"),
            ContactLastName = V("contactlastname"),
            ContactEmail = Contact.NormalizeEmail(V("contactemail")),
            ContactPhone = V("contactphone"),
            ContactTitle = V("contacttitle"),
            ContactRoles = ReadRoles(V("contactrole")),
            OwnerEmail = V("owner")?.ToLowerInvariant(),
            ExternalSystem = V("externalsystem"),
            ExternalId = V("externalid"),
            ParentOrgNumber = parent,
            ContractStart = start,
            ContractEnd = end,
            Currency = currency,
            VatRate = vat,
            ProductSku = V("productsku"),
        };

        // The first reason wins; the order is the order a person would fix them in.
        var issues = table.RowIssues(row);
        if (hasEncodingProblem && ContainsReplacement(table, row))
        {
            data.Reject(ImportReason.EncodingInvalid);
        }

        if (issues.Contains(CsvTable.RaggedExtra))
        {
            data.Reject(ImportReason.RaggedRow);
        }

        if (issues.Contains(CsvTable.UnterminatedQuote))
        {
            data.Reject(ImportReason.UnterminatedQuote);
        }

        if (issues.Contains(CsvTable.RaggedShort))
        {
            data.Warnings.Add(ImportReason.RaggedRow);
        }

        if (data.Name is null)
        {
            data.Reject(ImportReason.MissingName);
        }

        if (TooLong(data))
        {
            data.Reject(ImportReason.FieldTooLong);
        }

        if (rawNumber is not null && number is null)
        {
            data.Reject(ImportReason.InvalidOrgNumber);
        }

        if ((data.Email is not null && !IsEmail(data.Email)) || (data.InvoiceEmail is not null && !IsEmail(data.InvoiceEmail)))
        {
            data.Reject(ImportReason.InvalidEmail);
        }

        if (data.ContactEmail is not null && !IsEmail(data.ContactEmail))
        {
            data.Reject(ImportReason.InvalidContactEmail);
        }

        if (rawDomain is not null && domain is null)
        {
            data.Reject(ImportReason.InvalidDomain);
        }

        if (rawStatus is not null && status is null)
        {
            data.Reject(ImportReason.UnknownStatus);
        }

        if (data.OwnerEmail is not null && !IsEmail(data.OwnerEmail))
        {
            data.Reject(ImportReason.OwnerUnknown);
        }

        // Columns that are checked and reported, not imported.
        if ((startCode ?? endCode) is { } dateCode)
        {
            data.Reject(dateCode);
        }

        if (start is { } from && end is { } to && to < from)
        {
            data.Reject(ImportReason.ContractDatesOrder);
        }

        if (currency is not null && (currency.Length != 3 || !currency.All(char.IsAsciiLetterUpper)))
        {
            data.Reject(ImportReason.InvalidCurrency);
        }

        if (rawVat is not null && (vat is null || !VatRates.Contains(vat.Value)))
        {
            data.Reject(ImportReason.InvalidVatRate);
        }

        if (rawParent is not null && parent is null)
        {
            data.Reject(ImportReason.InvalidParentOrgNumber);
        }

        if ((data.ExternalSystem is null) != (data.ExternalId is null))
        {
            data.Reject(ImportReason.IncompleteExternalId);
        }

        data.SourceKey = SourceKeyOf(sourceSha256, data);
        return data;
    }

    /// <summary>Which of the optional columns carry a value on this row (they are validated, not imported).</summary>
    public static IEnumerable<string> ValidatedValues(MigrationRowData row)
    {
        if (row.ExternalSystem is not null)
        {
            yield return "externalsystem";
        }

        if (row.ExternalId is not null)
        {
            yield return "externalid";
        }

        if (row.ParentOrgNumber is not null)
        {
            yield return "parentorgnumber";
        }

        if (row.ContractStart is not null)
        {
            yield return "contractstart";
        }

        if (row.ContractEnd is not null)
        {
            yield return "contractend";
        }

        if (row.Currency is not null)
        {
            yield return "currency";
        }

        if (row.VatRate is not null)
        {
            yield return "vatrate";
        }

        if (row.ProductSku is not null)
        {
            yield return "productsku";
        }
    }

    /// <summary>The domain as a bare host name: no scheme, user, port, path or trailing slash, lower case; null when it is not one.</summary>
    public static string? NormalizeDomain(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var text = raw.Trim().ToLowerInvariant();
        var scheme = text.IndexOf("://", StringComparison.Ordinal);
        if (scheme >= 0)
        {
            text = text[(scheme + 3)..];
        }

        var end = text.IndexOfAny(['/', '?', '#']);
        if (end >= 0)
        {
            text = text[..end];
        }

        var at = text.LastIndexOf('@');
        if (at >= 0)
        {
            text = text[(at + 1)..];
        }

        var colon = text.IndexOf(':', StringComparison.Ordinal);
        if (colon >= 0)
        {
            text = text[..colon];
        }

        text = text.Trim('.');
        var labels = text.Split('.');
        var valid = labels.Length >= 2 && labels.All(l => l.Length is > 0 and <= 63 && !l.StartsWith('-') && !l.EndsWith('-') &&
                                                       l.All(c => char.IsLetterOrDigit(c) || c == '-'));
        return valid ? text : null;
    }

    public static bool IsEmail(string value) =>
        value.Length <= 256 && !value.Any(char.IsWhiteSpace) && MailAddress.TryCreate(value, out var address) &&
        address.Address == value && address.Host.Contains('.', StringComparison.Ordinal);

    /// <summary>A salted hash: the same organization number in two files relates the rows without either being stored.</summary>
    public static string SourceKeyOf(string sourceSha256, MigrationRowData row)
    {
        var key = row.OrgNumber is not null
            ? $"orgnr:{row.OrgNumber}"
            : row.Name is not null ? $"name:{DuplicateDetector.NormalizeName(row.Name)}" : $"line:{row.Line}";
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{sourceSha256}|{key}")));
    }

    private static DateOnly? ReadDate(string? value, out string? problem)
    {
        var date = CsvTable.Date(value, out var ambiguous);
        problem = ambiguous ? ImportReason.AmbiguousDate : value is not null && date is null ? ImportReason.InvalidDate : null;
        return date;
    }

    private static bool? ReadFlag(string? value) => value?.ToLowerInvariant() switch
    {
        "true" or "ja" or "yes" or "1" => true,
        "false" or "nei" or "no" or "0" => false,
        _ => null,
    };

    private static ContactRoles ReadRoles(string? value) => value?.ToLowerInvariant() switch
    {
        "decisionmaker" or "beslutningstaker" or "lpr" => ContactRoles.DecisionMaker,
        "technical" or "teknisk" => ContactRoles.Technical,
        "billing" or "faktura" => ContactRoles.Billing,
        "enduser" or "sluttbruker" => ContactRoles.EndUser,
        _ => ContactRoles.None,
    };

    private static bool ContainsReplacement(CsvTable table, int row)
    {
        foreach (var column in Aliases.Values.Distinct())
        {
            if (table.Value(row, column)?.Contains('�', StringComparison.Ordinal) == true)
            {
                return true;
            }
        }

        return false;
    }

    // The widest each value may be in the database; a longer one would fail a whole chunk when saved.
    private static bool TooLong(MigrationRowData r) =>
        Over(r.Name, 256) || Over(r.Email, 256) || Over(r.InvoiceEmail, 256) || Over(r.Phone, 32) || Over(r.Website, 240) ||
        Over(r.Domain, 240) || Over(r.Street, 256) || Over(r.PostalCode, 16) || Over(r.City, 128) || Over(r.ContactFirstName, 128) ||
        Over(r.ContactLastName, 128) || Over(r.ContactEmail, 256) || Over(r.ContactPhone, 32) || Over(r.ContactTitle, 128) ||
        Over(r.OwnerEmail, 256);

    private static bool Over(string? value, int max) => value is not null && value.Length > max;

    public static string FormatDate(DateOnly date) => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
