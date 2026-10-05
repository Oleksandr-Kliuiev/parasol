using System.Globalization;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>What one compared key came out as (DEV-22). Matched is the only status that needs no explanation.</summary>
public static class PilotStatus
{
    public const string Matched = "Matched";
    public const string Different = "Different";

    /// <summary>The independent figures have the key, the CRM run has nothing for it.</summary>
    public const string MissingInCrm = "MissingInCrm";

    /// <summary>The CRM run bills something the independent figures do not mention.</summary>
    public const string MissingInFile = "MissingInFile";

    /// <summary>The organization number of the file is not a customer of the CRM.</summary>
    public const string MissingCustomer = "MissingCustomer";

    /// <summary>The row could not be read or does not belong to this comparison; nothing was compared.</summary>
    public const string Rejected = "Rejected";
}

/// <summary>
/// One compared key: payer × currency × group (× product code when the file names one). Amounts exclude VAT. A difference is
/// the file's amount minus the CRM's, compared exactly at two decimals — there is no tolerance.
/// </summary>
public sealed record PilotCompareItem(
    string Key,
    string Status,
    string? ReasonCode,
    int? Line,
    string? OrgNumber,
    Guid? PayerId,
    string Currency,
    string? Group,
    string? ProductCode,
    int FileRows,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? FileAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Difference,
    decimal? FileQuantity,
    decimal? CrmQuantity,
    int CrmLines,
    IReadOnlyList<string> ExternalRefs);

public sealed record PilotPayerSummary(
    string PayerKey,
    string? OrgNumber,
    Guid? PayerId,
    string Currency,
    int Keys,
    int Exceptions,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? FileAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Difference,
    string Status);

public sealed record PilotTotals(
    string Currency,
    int Keys,
    int Exceptions,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? FileAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? CrmAmount,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Difference);

/// <summary>
/// The comparison as it is stored (DEV-22): create-only, one object per comparison. It carries ids, codes and amounts — no
/// customer name and no contact. <see cref="ContentDigest"/> is the digest of the run's content when the comparison was made.
/// </summary>
public sealed record PilotComparisonDocument(
    string SchemaVersion,
    Guid ComparisonId,
    Guid RunId,
    DateOnly PeriodStart,
    string RunStatus,
    int RunContentRevision,
    int? RunApprovedRevision,
    string? RunApprovedDigest,
    string ContentDigest,
    string FileSha256,
    int FileRows,
    IReadOnlyList<string> UnknownColumns,
    DateTimeOffset At,
    Guid CreatedBy,
    int ExceptionCount,
    IReadOnlyDictionary<string, int> StatusCounts,
    IReadOnlyList<PilotTotals> Totals,
    IReadOnlyList<PilotPayerSummary> Payers,
    IReadOnlyList<PilotCompareItem> Items);

/// <summary><see cref="DocumentSha256"/> is the hash of the stored object; a sign-off names it so that it signs exactly what was shown.</summary>
public sealed record PilotComparisonResult(string DocumentSha256, string DocumentKey, PilotComparisonDocument Comparison);

public sealed record PilotExplanation(string Key, string Text, string OwnerRole);

/// <summary>
/// The Finance sign-off of a comparison. <see cref="Statement"/> must be <see cref="PilotSignoff.Statement"/> word for word: a
/// fixed acknowledgement, so nobody signs a sentence they have not read. The signer is never in the body — it is the signed-in user.
/// </summary>
public sealed record PilotSignoffRequest(
    Guid ComparisonId, string ComparisonSha256, IReadOnlyList<PilotExplanation> Explanations, string FallbackProcess, string Statement);

public static class PilotSignoff
{
    public const string Statement =
        "I have compared the independent figures with the CRM run, and every difference has an owner and an explanation.";
}

internal sealed class PilotSignoffRequestValidator : AbstractValidator<PilotSignoffRequest>
{
    public PilotSignoffRequestValidator()
    {
        RuleFor(x => x.ComparisonId).NotEmpty();
        RuleFor(x => x.ComparisonSha256).NotEmpty().Length(64).Matches("^[0-9a-f]{64}$");
        RuleFor(x => x.FallbackProcess).NotEmpty().MinimumLength(10).MaximumLength(2000);
        RuleFor(x => x.Statement).Equal(PilotSignoff.Statement).WithMessage("The statement must be given exactly as shown.");
        RuleFor(x => x.Explanations).NotNull().Must(e => e is null || e.Count <= PilotComparisonService.MaxRows * 2)
            .WithMessage("Too many explanations.");
        RuleForEach(x => x.Explanations).ChildRules(e =>
        {
            e.RuleFor(x => x.Key).NotEmpty().MaximumLength(256);
            e.RuleFor(x => x.Text).NotEmpty().MinimumLength(10).MaximumLength(1000);
            e.RuleFor(x => x.OwnerRole).NotEmpty().Must(role => CrmRoles.All.Contains(role)).WithMessage("The owner must be one of the CRM roles.");
        });
    }
}

/// <summary>The signed document (DEV-22): the signer is an id and the time is the server's.</summary>
public sealed record PilotSignoffDocument(
    string SchemaVersion,
    Guid SignoffId,
    Guid RunId,
    DateOnly PeriodStart,
    Guid ComparisonId,
    string ComparisonSha256,
    string FileSha256,
    int RunContentRevision,
    string? RunApprovedDigest,
    string ContentDigest,
    int ExceptionCount,
    IReadOnlyDictionary<string, int> StatusCounts,
    IReadOnlyList<PilotSignedExplanation> Explanations,
    string FallbackProcess,
    string Statement,
    Guid SignedBy,
    DateTimeOffset SignedAt);

public sealed record PilotSignedExplanation(string Key, string Status, string Text, string OwnerRole);

public sealed record PilotSignoffResult(Guid SignoffId, string DocumentSha256, string DocumentKey, DateTimeOffset SignedAt, int ExceptionCount);

public sealed record PilotComparisonInfo(
    Guid Id, string DocumentSha256, string FileSha256, int FileRows, DateTimeOffset At, RefDto CreatedBy, int RunContentRevision, bool Stale,
    int ExceptionCount, IReadOnlyDictionary<string, int> StatusCounts, int Signoffs);

public sealed record PilotSignoffInfo(
    Guid Id, Guid ComparisonId, string DocumentSha256, string ComparisonSha256, DateTimeOffset SignedAt, RefDto SignedBy, int ExceptionCount,
    int RunContentRevision, bool Stale);

/// <summary>Metadata of the comparisons and sign-offs of a run: hashes, counts and people, never an amount or an explanation.</summary>
public sealed record PilotOverview(
    Guid RunId, int ContentRevision, string Statement, IReadOnlyList<PilotComparisonInfo> Comparisons, IReadOnlyList<PilotSignoffInfo> Signoffs);

/// <summary>
/// The independent calculation against the CRM run, and the sign-off of the result (DEV-22). Nothing is written to a billing
/// table: a comparison and a sign-off are create-only objects in the document store, and each leaves an audit entry with ids and
/// hashes. Only the signed-in user signs; there is no way to sign for somebody else.
/// </summary>
internal sealed class PilotComparisonService(
    BillingDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    IDocumentStore store,
    IUserDirectory users,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time)
{
    public const int MaxRows = 5_000;
    public const string ComparisonSchema = "billing-pilot-comparison/1";
    public const string SignoffSchema = "billing-pilot-signoff/1";
    private const string Nok = "NOK";
    private const string NoProduct = "(none)";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["orgnr"] = "orgnumber", ["orgnumber"] = "orgnumber", ["organisasjonsnummer"] = "orgnumber", ["orgno"] = "orgnumber",
        ["period"] = "period", ["periode"] = "period", ["month"] = "period",
        ["currency"] = "currency", ["valuta"] = "currency",
        ["group"] = "group", ["gruppe"] = "group", ["linegroup"] = "group",
        ["productcode"] = "product", ["produktkode"] = "product", ["sku"] = "product", ["product"] = "product",
        ["quantity"] = "quantity", ["antall"] = "quantity", ["qty"] = "quantity",
        ["amountexvat"] = "amount", ["amount"] = "amount", ["belopeksmva"] = "amount", ["belop"] = "amount", ["beløp"] = "amount", ["sum"] = "amount",
        ["externalref"] = "ref", ["externalreference"] = "ref", ["ref"] = "ref", ["reference"] = "ref", ["referanse"] = "ref",
    };

    private static readonly Dictionary<string, BillingGroup> Groups = new(StringComparer.Ordinal)
    {
        ["subscription"] = BillingGroup.Subscription, ["abonnement"] = BillingGroup.Subscription,
        ["license"] = BillingGroup.License, ["licence"] = BillingGroup.License, ["lisens"] = BillingGroup.License,
        ["hourlywork"] = BillingGroup.HourlyWork, ["hourly"] = BillingGroup.HourlyWork, ["timer"] = BillingGroup.HourlyWork,
        ["hourbank"] = BillingGroup.HourBank, ["timebank"] = BillingGroup.HourBank,
        ["oneoff"] = BillingGroup.OneOff, ["engang"] = BillingGroup.OneOff, ["engangs"] = BillingGroup.OneOff,
    };

    private sealed record FileRow(int Line, string OrgNumber, string Currency, BillingGroup? Group, string? Product, decimal? Quantity, decimal Amount, string? Ref);

    private sealed record CrmLine(Guid Payer, BillingGroup Group, string Product, decimal Quantity, decimal Total);

    private sealed record Level(string Org, string Currency, BillingGroup? Group, string? Product);

    // ---------- Compare ----------

    public async Task<Result<PilotComparisonResult>> CompareAsync(Guid runId, byte[] file, CancellationToken ct)
    {
        if (currentUser.UserId is not { } userId)
        {
            return PilotErrors.UserRequired;
        }

        if (await db.BillingRuns.AsNoTracking().SingleOrDefaultAsync(r => r.Id == runId, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(runId);
        }

        if (run.CollectedAt is null)
        {
            return PilotErrors.NotCollected;
        }

        var (text, _) = Decode(file);
        var table = CsvTable.Parse(text, Aliases);
        if (table is null || !table.Has("orgnumber") || !table.Has("period") || !table.Has("currency") || !table.Has("amount"))
        {
            return PilotErrors.FileInvalid;
        }

        if (table.RowCount > MaxRows)
        {
            return Error.Validation("BIL_PILOT_FILE_TOO_LARGE", $"Split the file: at most {MaxRows} rows at a time.", new Dictionary<string, object?> { ["maxRows"] = MaxRows });
        }

        var items = new List<PilotCompareItem>();
        var rows = ReadRows(table, run.PeriodStart, items);
        RejectMixedGranularity(rows, items);

        var bases = await db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == runId).ToListAsync(ct);
        var contentDigest = BillingContentDigest.Compute(bases);
        var crm = await CrmLinesAsync(bases, ct);

        var fileNumbers = rows.Select(r => r.OrgNumber).Distinct(StringComparer.Ordinal).ToList();
        var organizations = fileNumbers.Count == 0
            ? new Dictionary<string, Guid>()
            : (await customers.FindOrganizationsByOrgNumberAsync(fileNumbers, ct)).ToDictionary(o => o.Key, o => o.Value, StringComparer.Ordinal);
        var numbers = await customers.GetOrgNumbersAsync(crm.Select(c => c.Payer).Distinct().ToList(), ct);

        // What the file says, grouped to the level it was given.
        var fileGroups = rows
            .GroupBy(r => new Level(r.OrgNumber, r.Currency, r.Group, r.Product))
            .OrderBy(g => g.Key.Org, StringComparer.Ordinal).ThenBy(g => g.Key.Currency, StringComparer.Ordinal)
            .ThenBy(g => g.Key.Group?.ToString(), StringComparer.Ordinal).ThenBy(g => g.Key.Product, StringComparer.Ordinal)
            .ToList();
        foreach (var group in fileGroups)
        {
            organizations.TryGetValue(group.Key.Org, out var payerId);
            var known = organizations.ContainsKey(group.Key.Org);
            var fileAmount = Round(group.Sum(r => r.Amount));
            var quantities = group.All(r => r.Quantity is not null) ? group.Sum(r => r.Quantity!.Value) : (decimal?)null;
            var refs = group.Select(r => r.Ref).Where(r => r is not null).Select(r => r!).Distinct(StringComparer.Ordinal).Take(20).ToList();
            var key = KeyOf(group.Key.Org, group.Key.Currency, group.Key.Group, group.Key.Product);
            if (!known)
            {
                items.Add(new PilotCompareItem(key, PilotStatus.MissingCustomer, "UNKNOWN_ORG_NUMBER", null, group.Key.Org, null, group.Key.Currency,
                    group.Key.Group?.ToString(), group.Key.Product, group.Count(), fileAmount, null, null, quantities, null, 0, refs));
                continue;
            }

            var matching = group.Key.Currency == Nok
                ? crm.Where(c => c.Payer == payerId && (group.Key.Group is null || c.Group == group.Key.Group) &&
                                 (group.Key.Product is null || c.Product == group.Key.Product)).ToList()
                : [];
            var crmAmount = Round(matching.Sum(c => c.Total));
            var crmQuantity = matching.Count == 0 ? (decimal?)null : Round(matching.Sum(c => c.Quantity));
            var difference = Round(fileAmount - crmAmount);
            var quantityDiffers = quantities is { } fileQuantity && Round(fileQuantity) != (crmQuantity ?? 0m);
            string status;
            string? reason = null;
            if (matching.Count == 0 && fileAmount != 0m)
            {
                status = PilotStatus.MissingInCrm;
            }
            else if (difference != 0m || quantityDiffers)
            {
                status = PilotStatus.Different;
                reason = difference != 0m ? (quantityDiffers ? "AMOUNT_AND_QUANTITY" : "AMOUNT") : "QUANTITY";
            }
            else
            {
                status = PilotStatus.Matched;
            }

            items.Add(new PilotCompareItem(key, status, reason, null, group.Key.Org, payerId, group.Key.Currency, group.Key.Group?.ToString(), group.Key.Product,
                group.Count(), fileAmount, crmAmount, difference, quantities, crmQuantity, matching.Count, refs));
        }

        // What the CRM bills that the file does not list. The file's own level decides how far down it is looked at.
        foreach (var payer in crm.GroupBy(c => c.Payer))
        {
            var org = numbers.TryGetValue(payer.Key, out var number) ? number : $"id:{payer.Key:N}";
            var fileLevels = fileGroups.Where(g => g.Key.Org == org && g.Key.Currency == Nok).Select(g => g.Key).ToList();
            if (fileLevels.Any(l => l.Group is null))
            {
                continue;
            }

            foreach (var group in payer.GroupBy(c => c.Group).OrderBy(g => g.Key.ToString(), StringComparer.Ordinal))
            {
                var inGroup = fileLevels.Where(l => l.Group == group.Key).ToList();
                if (inGroup.Count == 0)
                {
                    AddMissingInFile(items, payer.Key, org, group.Key, null, group.ToList());
                }
                else if (inGroup.Any(l => l.Product is not null))
                {
                    var listed = inGroup.Select(l => l.Product).ToHashSet(StringComparer.Ordinal);
                    foreach (var product in group.GroupBy(c => c.Product).Where(p => !listed.Contains(p.Key)).OrderBy(p => p.Key, StringComparer.Ordinal))
                    {
                        AddMissingInFile(items, payer.Key, org, group.Key, product.Key, product.ToList());
                    }
                }
            }
        }

        var ordered = items
            .OrderBy(i => i.Status == PilotStatus.Rejected ? 1 : 0)
            .ThenBy(i => i.OrgNumber, StringComparer.Ordinal).ThenBy(i => i.Currency, StringComparer.Ordinal)
            .ThenBy(i => i.Group, StringComparer.Ordinal).ThenBy(i => i.ProductCode, StringComparer.Ordinal).ThenBy(i => i.Line)
            .ToList();
        var comparisonId = SequentialId.New();
        var now = time.GetUtcNow();
        var statusCounts = ordered.GroupBy(i => i.Status).OrderBy(g => g.Key, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        var document = new PilotComparisonDocument(
            ComparisonSchema, comparisonId, runId, run.PeriodStart, run.Status.ToString(), run.ContentRevision, run.ApprovedRevision, run.ApprovedDigest,
            contentDigest, Sha256Hex(file), table.RowCount, table.UnknownColumns, now, userId, ordered.Count(i => i.Status != PilotStatus.Matched), statusCounts,
            TotalsOf(ordered), PayersOf(ordered), ordered);

        var documentKey = ComparisonKey(runId, comparisonId);
        var stored = await store.PutAsync(documentKey, JsonSerializer.SerializeToUtf8Bytes(document, Json), "application/json", ct);
        if (!stored.Created)
        {
            return PilotErrors.KeyTaken;
        }

        db.RecordAudit(currentUser, requestContext, time, AuditActions.Reconcile, "BillingPilotComparison", comparisonId, new
        {
            RunId = runId,
            ComparisonId = comparisonId,
            RunContentRevision = run.ContentRevision,
            run.ApprovedDigest,
            ContentDigest = contentDigest,
            FileSha256 = document.FileSha256,
            DocumentSha256 = stored.Sha256,
            document.FileRows,
            document.ExceptionCount,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            // The comparison would exist without a trail: the object is an orphan of this failed request, nothing references it.
            await store.DeleteAsync(documentKey, CancellationToken.None);
            throw;
        }

        return new PilotComparisonResult(stored.Sha256, documentKey, document);
    }

    private static void AddMissingInFile(List<PilotCompareItem> items, Guid payer, string org, BillingGroup group, string? product, List<CrmLine> lines)
    {
        var amount = Round(lines.Sum(l => l.Total));
        if (amount == 0m)
        {
            return;
        }

        items.Add(new PilotCompareItem(
            KeyOf(org, Nok, group, product), PilotStatus.MissingInFile, null, null, org.StartsWith("id:", StringComparison.Ordinal) ? null : org, payer, Nok,
            group.ToString(), product, 0, 0m, amount, Round(-amount), null, Round(lines.Sum(l => l.Quantity)), lines.Count, []));
    }

    private static List<FileRow> ReadRows(CsvTable table, DateOnly period, List<PilotCompareItem> rejected)
    {
        var rows = new List<FileRow>();
        for (var row = 0; row < table.RowCount; row++)
        {
            var line = table.Line(row);
            var number = table.Value(row, "orgnumber");
            var currency = table.Value(row, "currency")?.ToUpperInvariant();
            var periodText = table.Value(row, "period");
            var groupText = table.Value(row, "group");
            var productText = table.Value(row, "product");
            var quantityText = table.Value(row, "quantity");
            var amountText = table.Value(row, "amount");
            var amount = CsvTable.Decimal(amountText);
            var quantity = CsvTable.Decimal(quantityText);
            var filePeriod = ReadPeriod(periodText);
            BillingGroup? group = null;
            var groupKnown = true;
            var isInfo = false;
            if (groupText is not null)
            {
                var normalizedGroup = CsvTable.Normalize(groupText);
                if (Groups.TryGetValue(normalizedGroup, out var parsedGroup))
                {
                    group = parsedGroup;
                }
                else if (normalizedGroup == "info")
                {
                    isInfo = true;
                }
                else
                {
                    groupKnown = false;
                }
            }

            var normalizedNumber = number is null ? null : new string(number.Where(c => !char.IsWhiteSpace(c)).ToArray());
            var reason =
                table.RowIssues(row).Count > 0 ? "RAGGED_ROW"
                : normalizedNumber is null || normalizedNumber.Length != 9 || !normalizedNumber.All(char.IsAsciiDigit) ? "INVALID_ORG_NUMBER"
                : filePeriod is null ? "INVALID_PERIOD"
                : filePeriod.Value != period ? "PERIOD_MISMATCH"
                : currency is not { Length: 3 } || !currency.All(char.IsAsciiLetterUpper) ? "INVALID_CURRENCY"
                : !groupKnown ? "INVALID_GROUP"
                : productText is { Length: > 64 } ? "INVALID_PRODUCT_CODE"
                : amount is null ? "INVALID_AMOUNT"
                : quantityText is not null && quantity is null ? "INVALID_QUANTITY"
                : new[] { number, currency, groupText, productText, quantityText, amountText }.Any(v => v is not null && v.Contains('�', StringComparison.Ordinal)) ? "INVALID_ENCODING"
                : null;
            if (reason is null && isInfo)
            {
                // Information lines carry hours a contract or hour bank already covers; they have no price to compare.
                reason = "GROUP_NOT_COMPARABLE";
            }

            if (reason is not null)
            {
                rejected.Add(new PilotCompareItem($"line:{line}", PilotStatus.Rejected, reason, line, normalizedNumber is { Length: 9 } ? normalizedNumber : null, null,
                    currency ?? string.Empty, groupText is { Length: <= 32 } ? groupText : null, null, 1, null, null, null, null, null, 0, []));
                continue;
            }

            var reference = table.Value(row, "ref");
            rows.Add(new FileRow(
                line, normalizedNumber!, currency!, group, productText?.Trim().ToUpperInvariant(), quantity, amount!.Value,
                reference is { Length: > 100 } ? reference[..100] : reference));
        }

        return rows;
    }

    // Per payer and currency one level: payer, or group; and per group one level: group, or product. Mixing them would count
    // the same money twice or leave some of it out, so the rows that do not fit the finer level are set aside.
    private static void RejectMixedGranularity(List<FileRow> rows, List<PilotCompareItem> rejected)
    {
        var drop = new HashSet<FileRow>();
        foreach (var payer in rows.GroupBy(r => (r.OrgNumber, r.Currency)))
        {
            if (payer.Any(r => r.Group is not null))
            {
                drop.UnionWith(payer.Where(r => r.Group is null));
            }

            foreach (var group in payer.Where(r => r.Group is not null).GroupBy(r => r.Group))
            {
                if (group.Any(r => r.Product is not null))
                {
                    drop.UnionWith(group.Where(r => r.Product is null));
                }
            }
        }

        foreach (var row in drop.OrderBy(r => r.Line))
        {
            rejected.Add(new PilotCompareItem($"line:{row.Line}", PilotStatus.Rejected, "MIXED_GRANULARITY", row.Line, row.OrgNumber, null, row.Currency,
                row.Group?.ToString(), row.Product, 1, null, null, null, null, null, 0, []));
        }

        rows.RemoveAll(drop.Contains);
    }

    private async Task<List<CrmLine>> CrmLinesAsync(IReadOnlyList<BillingBasis> bases, CancellationToken ct)
    {
        var productIds = bases.SelectMany(b => b.BilledLines).Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        var products = productIds.Count == 0 ? new Dictionary<Guid, ProductRef>() : (await catalog.GetProductsAsync(productIds, ct)).ToDictionary(p => p.Key, p => p.Value);
        return bases
            .Where(b => b.Status != BillingBasisStatus.Cancelled)
            .SelectMany(b => b.BilledLines.Where(l => l.Group != BillingGroup.Info).Select(l => new CrmLine(
                b.OrganizationId,
                l.Group,
                (l.ProductCode ?? (l.ProductId is { } id ? products.GetValueOrDefault(id)?.Sku : null))?.Trim().ToUpperInvariant() ?? NoProduct,
                l.Quantity,
                l.LineTotal)))
            .ToList();
    }

    private static List<PilotTotals> TotalsOf(IReadOnlyList<PilotCompareItem> items) => items
        .Where(i => i.Status != PilotStatus.Rejected)
        .GroupBy(i => i.Currency)
        .OrderBy(g => g.Key, StringComparer.Ordinal)
        .Select(g =>
        {
            var file = Round(g.Sum(i => i.FileAmount ?? 0m));
            var crm = Round(g.Sum(i => i.CrmAmount ?? 0m));
            return new PilotTotals(g.Key, g.Count(), g.Count(i => i.Status != PilotStatus.Matched), file, crm, Round(file - crm));
        })
        .ToList();

    private static List<PilotPayerSummary> PayersOf(IReadOnlyList<PilotCompareItem> items) => items
        .Where(i => i.Status != PilotStatus.Rejected && i.OrgNumber is not null || i.PayerId is not null)
        .GroupBy(i => (Payer: i.OrgNumber ?? $"id:{i.PayerId:N}", i.Currency))
        .OrderBy(g => g.Key.Payer, StringComparer.Ordinal).ThenBy(g => g.Key.Currency, StringComparer.Ordinal)
        .Select(g =>
        {
            var file = Round(g.Sum(i => i.FileAmount ?? 0m));
            var crm = Round(g.Sum(i => i.CrmAmount ?? 0m));
            var exceptions = g.Count(i => i.Status != PilotStatus.Matched);
            return new PilotPayerSummary(
                g.Key.Payer, g.First().OrgNumber, g.Select(i => i.PayerId).FirstOrDefault(p => p is not null), g.Key.Currency, g.Count(), exceptions,
                file, crm, Round(file - crm), exceptions == 0 ? PilotStatus.Matched : PilotStatus.Different);
        })
        .ToList();

    // ---------- Sign-off ----------

    public async Task<Result<PilotSignoffResult>> SignAsync(Guid runId, PilotSignoffRequest request, string ifMatch, CancellationToken ct)
    {
        // The run on screen: the version the signer saw, tracked so the ETag can be checked (ADR-012).
        if (await db.BillingRuns.SingleOrDefaultAsync(r => r.Id == runId, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(runId);
        }

        if (!db.ApplyIfMatch(run, ifMatch))
        {
            return Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");
        }

        if (db.IsStale(run))
        {
            return BillingErrors.RunChanged;
        }

        if (currentUser.UserId is not { } signer)
        {
            return PilotErrors.UserRequired;
        }

        if (await users.GetProfileAsync(signer, ct) is not { IsActive: true })
        {
            return PilotErrors.SignerInactive;
        }

        var bytes = await store.ReadAsync(ComparisonKey(runId, request.ComparisonId), ct);
        var comparison = bytes is null ? null : JsonSerializer.Deserialize<PilotComparisonDocument>(bytes, Json);
        if (bytes is null || comparison is null || comparison.RunId != runId || comparison.ComparisonId != request.ComparisonId)
        {
            return PilotErrors.ComparisonNotFound;
        }

        var documentSha = DocumentHashes.Sha256(bytes);
        if (!string.Equals(documentSha, request.ComparisonSha256, StringComparison.Ordinal))
        {
            return PilotErrors.ComparisonMismatch;
        }

        // The comparison is about one version of the run. A collect or a change of lines since then makes it a statement about
        // something that is no longer there.
        var bases = await db.BillingBases.AsNoTracking().Include(b => b.Lines).Where(b => b.RunId == runId).ToListAsync(ct);
        if (comparison.RunContentRevision != run.ContentRevision || comparison.ContentDigest != BillingContentDigest.Compute(bases))
        {
            return PilotErrors.ComparisonStale;
        }

        var exceptions = comparison.Items.Where(i => i.Status != PilotStatus.Matched).ToDictionary(i => i.Key, StringComparer.Ordinal);
        var explanations = request.Explanations ?? [];
        if (explanations.GroupBy(e => e.Key, StringComparer.Ordinal).FirstOrDefault(g => g.Count() > 1) is { } duplicate)
        {
            return Error.Validation("BIL_PILOT_EXPLANATION_DUPLICATE", "Each key is explained once.", new Dictionary<string, object?> { ["key"] = duplicate.Key });
        }

        if (explanations.FirstOrDefault(e => !exceptions.ContainsKey(e.Key)) is { } unknown)
        {
            return Error.Validation(
                "BIL_PILOT_EXPLANATION_UNKNOWN", "An explanation names a key that is not an exception of this comparison.", new Dictionary<string, object?> { ["key"] = unknown.Key });
        }

        var explained = explanations.Select(e => e.Key).ToHashSet(StringComparer.Ordinal);
        var missing = exceptions.Keys.Where(k => !explained.Contains(k)).OrderBy(k => k, StringComparer.Ordinal).ToList();
        if (missing.Count > 0)
        {
            return Error.Conflict(
                "BIL_PILOT_UNEXPLAINED", $"{missing.Count} difference(s) have no explanation with an owner.",
                new Dictionary<string, object?> { ["count"] = missing.Count, ["keys"] = missing.Take(20).ToList() });
        }

        var signoffId = SequentialId.New();
        var now = time.GetUtcNow();
        var document = new PilotSignoffDocument(
            SignoffSchema, signoffId, runId, comparison.PeriodStart, comparison.ComparisonId, documentSha, comparison.FileSha256, run.ContentRevision,
            run.ApprovedDigest, comparison.ContentDigest, comparison.ExceptionCount, comparison.StatusCounts,
            explanations.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => new PilotSignedExplanation(e.Key, exceptions[e.Key].Status, e.Text.Trim(), e.OwnerRole)).ToList(),
            request.FallbackProcess.Trim(), PilotSignoff.Statement, signer, now);
        var key = SignoffKey(runId, signoffId);
        var stored = await store.PutAsync(key, JsonSerializer.SerializeToUtf8Bytes(document, Json), "application/json", ct);
        if (!stored.Created)
        {
            return PilotErrors.KeyTaken;
        }

        // Ids and hashes only: the explanations and the fallback process are in the signed document, not in the trail.
        db.RecordAudit(currentUser, requestContext, time, AuditActions.Sign, "BillingPilotSignoff", signoffId, new
        {
            RunId = runId,
            SignoffId = signoffId,
            ComparisonId = comparison.ComparisonId,
            ComparisonSha256 = documentSha,
            SignoffSha256 = stored.Sha256,
            RunContentRevision = run.ContentRevision,
            run.ApprovedDigest,
            comparison.ExceptionCount,
            Explained = explanations.Count,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            await store.DeleteAsync(key, CancellationToken.None);
            throw;
        }

        return new PilotSignoffResult(signoffId, stored.Sha256, key, now, comparison.ExceptionCount);
    }

    // ---------- Overview ----------

    public async Task<Result<PilotOverview>> OverviewAsync(Guid runId, CancellationToken ct)
    {
        if (await db.BillingRuns.AsNoTracking().Where(r => r.Id == runId).Select(r => new { r.ContentRevision }).SingleOrDefaultAsync(ct) is not { } run)
        {
            return BillingErrors.RunNotFound(runId);
        }

        var comparisons = new List<(PilotComparisonDocument Document, string Sha)>();
        var signoffs = new List<(PilotSignoffDocument Document, string Sha)>();
        await foreach (var item in store.ListAsync(Folder(runId), ct))
        {
            var name = item.Key[(item.Key.LastIndexOf('/') + 1)..];
            if (await store.ReadAsync(item.Key, ct) is not { } bytes)
            {
                continue;
            }

            if (name.StartsWith("comparison-", StringComparison.Ordinal) && JsonSerializer.Deserialize<PilotComparisonDocument>(bytes, Json) is { } comparison)
            {
                comparisons.Add((comparison, DocumentHashes.Sha256(bytes)));
            }
            else if (name.StartsWith("signoff-", StringComparison.Ordinal) && JsonSerializer.Deserialize<PilotSignoffDocument>(bytes, Json) is { } signoff)
            {
                signoffs.Add((signoff, DocumentHashes.Sha256(bytes)));
            }
        }

        var people = await users.GetUsersAsync(
            comparisons.Select(c => c.Document.CreatedBy).Concat(signoffs.Select(s => s.Document.SignedBy)).Distinct().ToList(), ct);
        RefDto Person(Guid id) => people.TryGetValue(id, out var user) ? new RefDto(user.Id, user.DisplayName) : new RefDto(id, "—");

        return new PilotOverview(
            runId,
            run.ContentRevision,
            PilotSignoff.Statement,
            comparisons.OrderByDescending(c => c.Document.At).ThenByDescending(c => c.Document.ComparisonId)
                .Select(c => new PilotComparisonInfo(
                    c.Document.ComparisonId, c.Sha, c.Document.FileSha256, c.Document.FileRows, c.Document.At, Person(c.Document.CreatedBy),
                    c.Document.RunContentRevision, c.Document.RunContentRevision != run.ContentRevision, c.Document.ExceptionCount, c.Document.StatusCounts,
                    signoffs.Count(s => s.Document.ComparisonId == c.Document.ComparisonId)))
                .ToList(),
            signoffs.OrderByDescending(s => s.Document.SignedAt).ThenByDescending(s => s.Document.SignoffId)
                .Select(s => new PilotSignoffInfo(
                    s.Document.SignoffId, s.Document.ComparisonId, s.Sha, s.Document.ComparisonSha256, s.Document.SignedAt, Person(s.Document.SignedBy),
                    s.Document.ExceptionCount, s.Document.RunContentRevision, s.Document.RunContentRevision != run.ContentRevision))
                .ToList());
    }

    // ---------- Helpers ----------

    private static string Folder(Guid runId) => string.Create(CultureInfo.InvariantCulture, $"billing-pilot/{runId:N}/");

    private static string ComparisonKey(Guid runId, Guid comparisonId) => string.Create(CultureInfo.InvariantCulture, $"{Folder(runId)}comparison-{comparisonId:N}.json");

    private static string SignoffKey(Guid runId, Guid signoffId) => string.Create(CultureInfo.InvariantCulture, $"{Folder(runId)}signoff-{signoffId:N}.json");

    private static string KeyOf(string org, string currency, BillingGroup? group, string? product) =>
        $"{org}|{currency}|{group?.ToString() ?? "*"}|{product ?? "*"}";

    private static decimal Round(decimal value) => decimal.Round(value, 2, MidpointRounding.AwayFromZero);

    private static string Sha256Hex(byte[] content) => DocumentHashes.Sha256(content);

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

    private static (string Text, bool Broken) Decode(byte[] content)
    {
        string text;
        if (content is [0xFF, 0xFE, ..])
        {
            text = Encoding.Unicode.GetString(content);
        }
        else if (content is [0xFE, 0xFF, ..])
        {
            text = Encoding.BigEndianUnicode.GetString(content);
        }
        else
        {
            text = new UTF8Encoding(false, false).GetString(content);
        }

        return (text.TrimStart('﻿'), text.Contains('�', StringComparison.Ordinal));
    }
}

internal static class PilotErrors
{
    public static Error UserRequired => Error.Forbidden("BIL_PILOT_USER_REQUIRED", "A comparison and a sign-off need a signed-in CRM user.");

    public static Error SignerInactive => Error.Forbidden("BIL_PILOT_SIGNER_INACTIVE", "The CRM account of the signer is not active.");

    public static Error NotCollected => Error.Conflict("BIL_PILOT_RUN_NOT_COLLECTED", "The run has not been collected yet; there is nothing to compare.");

    public static Error FileInvalid => Error.Validation(
        "BIL_PILOT_FILE_INVALID", "The file needs a header row with orgnr, period, currency and amountExVat (group, productCode, quantity and externalRef are optional).");

    public static Error ComparisonNotFound => Error.NotFound("BIL_PILOT_COMPARISON_NOT_FOUND", "There is no such comparison for this run.");

    public static Error ComparisonMismatch => Error.Conflict(
        "BIL_PILOT_COMPARISON_MISMATCH", "The hash does not belong to the stored comparison: sign the comparison you were shown.");

    public static Error ComparisonStale => Error.Conflict(
        "BIL_PILOT_COMPARISON_STALE", "The run changed after this comparison was made (a collect or a change of lines). Compare again, then sign.");

    public static Error KeyTaken => Error.Conflict("BIL_PILOT_KEY_TAKEN", "A document with this key exists already; nothing was overwritten.");
}
