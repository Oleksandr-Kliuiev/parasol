using System.Globalization;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Organizations;

/// <summary>
/// One customer, month and currency of the cutover reconciliation (DEV-20). Amounts exclude VAT and are removed server-side
/// for callers without <c>finance.read</c>, who get the counts and the codes only.
/// </summary>
public sealed record ReconciliationLine(
    int? Line,
    string? OrgNumber,
    Guid? OrganizationId,
    string Period,
    string Currency,
    int FileRows,
    string Status,
    string? ReasonCode,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? FileAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmBilled,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmPending,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmUnconfirmed,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Difference);

public sealed record ReconciliationResult(
    string SourceSha256,
    int FileRows,
    int Customers,
    bool AmountsVisible,
    IReadOnlyDictionary<string, int> StatusCounts,
    IReadOnlyList<ReconciliationLine> Lines);

/// <summary>
/// Compares a small reconciliation file of the old system (organization number, month, currency, amount) with what the CRM
/// billed (DEV-20 cutover). Read-only: nothing is written anywhere; the CRM's side comes from Billing's register through its
/// contract. A customer, month or currency that is only on one side is a difference, not an omission.
/// </summary>
internal sealed class MigrationReconciliationService(CustomersDbContext db, IBillingApi billing, ICurrentUser currentUser)
{
    public const string Matched = "Matched";
    public const string Different = "Different";
    public const string Compared = "Compared";
    public const string MissingCustomer = "MissingCustomer";
    public const string MissingInCrm = "MissingInCrm";
    public const string MissingInFile = "MissingInFile";
    public const string Rejected = "Rejected";

    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["orgnumber"] = "orgnumber",
        ["orgnr"] = "orgnumber",
        ["organisasjonsnummer"] = "orgnumber",
        ["sourcekey"] = "orgnumber",
        ["period"] = "period",
        ["periode"] = "period",
        ["month"] = "period",
        ["currency"] = "currency",
        ["valuta"] = "currency",
        ["amount"] = "amount",
        ["belop"] = "amount",
        ["beløp"] = "amount",
        ["sum"] = "amount",
    };

    private sealed record Key(string OrgNumber, DateOnly Period, string Currency);

    private sealed class Total
    {
        public decimal Amount { get; set; }
        public int Rows { get; set; }
        public int FirstLine { get; init; }
    }

    public async Task<Result<ReconciliationResult>> ReconcileAsync(byte[] content, CancellationToken ct)
    {
        var (text, _) = MigrationImportService.Decode(content);
        var table = CsvTable.Parse(text, Aliases);
        if (table is null || !table.Has("orgnumber") || !table.Has("period") || !table.Has("currency") || !table.Has("amount"))
        {
            return Error.Validation("CUS_RECONCILIATION_INVALID", "The file needs a header row with organization number, period, currency and amount.");
        }

        if (table.RowCount > MigrationImportService.MaxRows)
        {
            return Error.Validation("CUS_MIGRATION_TOO_LARGE", $"Split the file: at most {MigrationImportService.MaxRows} rows at a time.");
        }

        var lines = new List<ReconciliationLine>();
        var totals = new Dictionary<Key, Total>();
        for (var row = 0; row < table.RowCount; row++)
        {
            var line = table.Line(row);
            var rawNumber = table.Value(row, "orgnumber");
            var currency = table.Value(row, "currency")?.ToUpperInvariant();
            var period = ReadPeriod(table.Value(row, "period"));
            var amount = CsvTable.Decimal(table.Value(row, "amount"));
            var reason =
                rawNumber is null || !OrgNumber.IsValid(rawNumber) ? ImportReason.InvalidOrgNumber
                : period is null ? "INVALID_PERIOD"
                : currency is not { Length: 3 } || !currency.All(char.IsAsciiLetterUpper) ? ImportReason.InvalidCurrency
                : amount is null ? "INVALID_AMOUNT"
                : table.RowIssues(row).Contains(CsvTable.RaggedExtra) ? ImportReason.RaggedRow
                : null;
            if (reason is not null)
            {
                lines.Add(new ReconciliationLine(line, null, null, period is null ? string.Empty : Format(period.Value), currency ?? string.Empty,
                    1, Rejected, reason, null, null, null, null, null));
                continue;
            }

            var key = new Key(OrgNumber.Normalize(rawNumber!), period!.Value, currency!);
            if (!totals.TryGetValue(key, out var total))
            {
                totals[key] = total = new Total { FirstLine = line };
            }

            total.Amount += amount!.Value;
            total.Rows++;
        }

        var numbers = totals.Keys.Select(k => k.OrgNumber).Distinct(StringComparer.Ordinal).ToList();
        var organizations = numbers.Count == 0
            ? new Dictionary<string, Guid>()
            : await db.Organizations.AsNoTracking().Where(o => o.OrgNumber != null && numbers.Contains(o.OrgNumber)).ToDictionaryAsync(o => o.OrgNumber!, o => o.Id, ct);
        var inCrm = new Dictionary<Key, BilledPeriodTotal>();
        if (organizations.Count > 0)
        {
            var first = totals.Keys.Min(k => k.Period);
            var last = totals.Keys.Max(k => k.Period);
            var byId = organizations.ToDictionary(o => o.Value, o => o.Key);
            foreach (var crm in await billing.GetBilledTotalsAsync(organizations.Values.ToList(), first, last, ct))
            {
                inCrm[new Key(byId[crm.OrganizationId], crm.PeriodStart, crm.Currency)] = crm;
            }
        }

        var amountsVisible = currentUser.HasPermission(Permissions.FinanceRead);
        foreach (var (key, total) in totals.OrderBy(t => t.Key.OrgNumber, StringComparer.Ordinal).ThenBy(t => t.Key.Period).ThenBy(t => t.Key.Currency, StringComparer.Ordinal))
        {
            var known = organizations.TryGetValue(key.OrgNumber, out var organizationId);
            inCrm.TryGetValue(key, out var crm);
            var billed = crm?.Billed ?? 0m;
            var difference = decimal.Round(total.Amount - billed, 2);
            var status = !known ? MissingCustomer : crm is null ? MissingInCrm : Math.Abs(difference) < 0.005m ? Matched : Different;
            lines.Add(new ReconciliationLine(
                total.FirstLine, key.OrgNumber, known ? organizationId : null, Format(key.Period), key.Currency, total.Rows, Mask(status, amountsVisible), null,
                decimal.Round(total.Amount, 2), known ? billed : null, known ? crm?.Pending ?? 0m : null, known ? crm?.Unconfirmed ?? 0m : null, known ? difference : null));
        }

        // What the CRM billed to the file's customers that the file does not list at all.
        var inFile = totals.Keys.ToHashSet();
        foreach (var (key, crm) in inCrm.Where(c => !inFile.Contains(c.Key)).OrderBy(c => c.Key.OrgNumber, StringComparer.Ordinal).ThenBy(c => c.Key.Period))
        {
            lines.Add(new ReconciliationLine(
                null, key.OrgNumber, crm.OrganizationId, Format(key.Period), key.Currency, 0, MissingInFile, null,
                0m, crm.Billed, crm.Pending, crm.Unconfirmed, decimal.Round(-crm.Billed, 2)));
        }

        var counts = lines.GroupBy(l => l.Status).OrderBy(g => g.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        return new ReconciliationResult(ImportRun.Sha256Hex(content), table.RowCount, organizations.Count, amountsVisible, counts, lines);
    }

    /// <summary>Without <c>finance.read</c> a comparison says that one was made, not how it came out: that would show the CRM's amounts.</summary>
    private static string Mask(string status, bool amountsVisible) =>
        amountsVisible || status is not (Matched or Different) ? status : Compared;

    private static DateOnly? ReadPeriod(string? value)
    {
        if (value is null)
        {
            return null;
        }

        if (DateOnly.TryParseExact(value.Trim(), "yyyy-MM", CultureInfo.InvariantCulture, DateTimeStyles.None, out var month))
        {
            return month;
        }

        return CsvTable.Date(value) is { } date ? new DateOnly(date.Year, date.Month, 1) : null;
    }

    private static string Format(DateOnly period) => period.ToString("yyyy-MM", CultureInfo.InvariantCulture);
}
