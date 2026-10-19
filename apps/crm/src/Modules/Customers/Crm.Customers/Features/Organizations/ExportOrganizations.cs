using ClosedXML.Excel;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

public sealed record ExportOrganizations(string? Search, OrganizationStatus? Status, Guid? AccountManagerId, string? Language);

public sealed record ExportFile(byte[] Content, string FileName, int Rows);

/// <summary>Excel export of the organization list with the list's filters (FR-GEN-02). Every export is audited.</summary>
internal sealed class ExportOrganizationsHandler(
    CustomersDbContext db,
    IUserDirectory users,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider timeProvider) : ICommandHandler<ExportOrganizations, Result<ExportFile>>
{
    public const int MaxRows = 50_000;
    public const string ContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<Result<ExportFile>> HandleAsync(ExportOrganizations command, CancellationToken cancellationToken)
    {
        var query = db.Organizations.AsNoTracking().ApplyFilters(command.Search, command.Status, command.AccountManagerId);
        var count = await query.CountAsync(cancellationToken);
        if (count > MaxRows)
        {
            return Error.Validation("EXPORT_TOO_LARGE", $"The export would contain {count} rows. Narrow the filters to at most {MaxRows}.");
        }

        var organizations = await query.OrderBy(o => o.Name).ThenBy(o => o.Id).ToListAsync(cancellationToken);
        var userIds = organizations
            .SelectMany(o => new[] { o.AccountManagerId, o.PrimaryTechnicianId })
            .Where(id => id.HasValue).Select(id => id!.Value).Distinct().ToList();
        var userNames = await users.GetUsersAsync(userIds, cancellationToken);
        string? Name(Guid? id) => id is { } v && userNames.TryGetValue(v, out var u) ? u.DisplayName : null;

        var headers = ExportHeaders.For(command.Language);
        using var workbook = new XLWorkbook();
        var sheet = workbook.AddWorksheet(headers.Sheet);
        string[] columns =
        [
            headers.Name, headers.OrgNumber, headers.LegalForm, headers.Status, headers.Nace, headers.Email, headers.Phone,
            headers.Website, headers.InvoiceEmail, headers.Ehf, headers.AccountManager, headers.PrimaryTechnician,
            headers.VisitStreet, headers.VisitPostalCode, headers.VisitCity, headers.PostalStreet, headers.PostalPostalCode,
            headers.PostalCity, headers.Domains, headers.Registry, headers.RegistryCheckedAt, headers.CreatedAt, headers.ModifiedAt,
        ];
        for (int c = 0; c < columns.Length; c++)
        {
            sheet.Cell(1, c + 1).Value = columns[c];
        }

        int row = 2;
        foreach (var o in organizations)
        {
            object?[] values =
            [
                o.Name, o.OrgNumber, o.LegalForm, headers.StatusName(o.Status), o.NaceCode, o.Email, o.Phone, o.Website, o.InvoiceEmail,
                o.EhfEnabled ? headers.Yes : headers.No, Name(o.AccountManagerId), Name(o.PrimaryTechnicianId),
                o.VisitAddress.Street, o.VisitAddress.PostalCode, o.VisitAddress.City,
                o.PostalAddress.Street, o.PostalAddress.PostalCode, o.PostalAddress.City,
                string.Join(", ", o.Domains), o.RegistryStatus.ToString(), Local(o.RegistryCheckedAt), Local(o.CreatedAt), Local(o.ModifiedAt),
            ];
            for (int c = 0; c < values.Length; c++)
            {
                var cell = sheet.Cell(row, c + 1);
                switch (values[c])
                {
                    case DateTime date:
                        cell.Value = date;
                        cell.Style.DateFormat.Format = "dd.MM.yyyy HH:mm";
                        break;
                    case string text:
                        // Org numbers and postal codes must stay text (leading zeros, no scientific notation).
                        cell.Value = text;
                        cell.Style.NumberFormat.Format = "@";
                        if (Crm.SharedKernel.Text.CsvCell.LooksLikeFormula(text))
                        {
                            // Stored as a text cell already; the quote prefix keeps Excel from evaluating it when someone edits the cell (F-G1-10).
                            cell.Style.IncludeQuotePrefix = true;
                        }
                        break;
                }
            }

            row++;
        }

        var table = sheet.Range(1, 1, Math.Max(row - 1, 1), columns.Length).CreateTable("Organizations");
        table.Theme = XLTableTheme.TableStyleLight9;
        sheet.SheetView.FreezeRows(1);
        sheet.Columns().AdjustToContents(1, Math.Min(row - 1, 200), 8, 60);

        using var stream = new MemoryStream();
        workbook.SaveAs(stream);

        db.RecordAudit(currentUser, requestContext, timeProvider, AuditActions.Export, nameof(Organization), Guid.Empty, new
        {
            Filters = new { command.Search, command.Status, command.AccountManagerId },
            Rows = organizations.Count,
        });
        await db.SaveChangesAsync(cancellationToken);

        var fileName = $"organizations-{TimeZoneInfo.ConvertTime(timeProvider.GetUtcNow(), Oslo):yyyy-MM-dd-HHmm}.xlsx";
        return new ExportFile(stream.ToArray(), fileName, organizations.Count);
    }

    private static DateTime? Local(DateTimeOffset? value) =>
        value is { } v ? TimeZoneInfo.ConvertTime(v, Oslo).DateTime : null;
}

internal sealed record ExportHeaders(
    string Sheet, string Name, string OrgNumber, string LegalForm, string Status, string Nace, string Email, string Phone, string Website,
    string InvoiceEmail, string Ehf, string AccountManager, string PrimaryTechnician, string VisitStreet, string VisitPostalCode,
    string VisitCity, string PostalStreet, string PostalPostalCode, string PostalCity, string Domains, string Registry,
    string RegistryCheckedAt, string CreatedAt, string ModifiedAt, string Yes, string No, IReadOnlyDictionary<OrganizationStatus, string> Statuses)
{
    public string StatusName(OrganizationStatus status) => Statuses[status];

    private static readonly ExportHeaders Norwegian = new(
        "Organisasjoner", "Navn", "Organisasjonsnummer", "Organisasjonsform", "Status", "Næringskode", "E-post", "Telefon", "Nettside",
        "Faktura-e-post", "EHF", "Kundeansvarlig", "Hovedtekniker", "Besøksadresse", "Besøk postnr.", "Besøk sted", "Postadresse",
        "Postnr.", "Poststed", "Domener", "Registerstatus", "Registerkontroll", "Opprettet", "Endret", "Ja", "Nei",
        new Dictionary<OrganizationStatus, string>
        {
            [OrganizationStatus.Lead] = "Lead", [OrganizationStatus.Prospect] = "Prospekt", [OrganizationStatus.Customer] = "Kunde",
            [OrganizationStatus.Former] = "Tidligere kunde", [OrganizationStatus.Partner] = "Partner",
        });

    private static readonly ExportHeaders Nynorsk = new(
        "Organisasjonar", "Namn", "Organisasjonsnummer", "Organisasjonsform", "Status", "Næringskode", "E-post", "Telefon", "Nettside",
        "Faktura-e-post", "EHF", "Kundeansvarleg", "Hovudtekniker", "Besøksadresse", "Besøk postnr.", "Besøk stad", "Postadresse",
        "Postnr.", "Poststad", "Domene", "Registerstatus", "Registerkontroll", "Oppretta", "Endra", "Ja", "Nei",
        new Dictionary<OrganizationStatus, string>
        {
            [OrganizationStatus.Lead] = "Lead", [OrganizationStatus.Prospect] = "Prospekt", [OrganizationStatus.Customer] = "Kunde",
            [OrganizationStatus.Former] = "Tidlegare kunde", [OrganizationStatus.Partner] = "Partnar",
        });

    private static readonly ExportHeaders English = new(
        "Organizations", "Name", "Organization number", "Legal form", "Status", "NACE", "E-mail", "Phone", "Website",
        "Invoice e-mail", "EHF", "Account manager", "Primary technician", "Visiting address", "Visiting postal code", "Visiting city",
        "Postal address", "Postal code", "City", "Domains", "Registry status", "Registry checked", "Created", "Changed", "Yes", "No",
        new Dictionary<OrganizationStatus, string>
        {
            [OrganizationStatus.Lead] = "Lead", [OrganizationStatus.Prospect] = "Prospect", [OrganizationStatus.Customer] = "Customer",
            [OrganizationStatus.Former] = "Former customer", [OrganizationStatus.Partner] = "Partner",
        });

    public static ExportHeaders For(string? language) => language switch
    {
        "en" => English,
        "nn" => Nynorsk,
        _ => Norwegian,
    };
}
