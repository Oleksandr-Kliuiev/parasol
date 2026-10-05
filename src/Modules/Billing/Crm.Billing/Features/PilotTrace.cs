using System.Globalization;
using System.Text.Json;
using ClosedXML.Excel;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Crm.SharedKernel.Text;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>
/// One billing line of a run with where it came from and where it went (DEV-22): the payer and the customer the service was
/// delivered to, the charge identity, what Finance decided about it and why, the anomalies of its basis, and the order and the
/// invoice that followed. Prices and totals are removed for callers without <c>finance.read</c>.
/// </summary>
public sealed record PilotTraceRow(
    Guid LineId,
    Guid BasisId,
    Guid RunId,
    RefDto Payer,
    string? PayerOrgNumber,
    RefDto? SourceOrganization,
    BillingGroup Group,
    string? ProductCode,
    string Description,
    string? SourceKey,
    DateOnly PeriodStart,
    DateOnly PeriodEnd,
    decimal Quantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? UnitPrice,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? DiscountPct,
    decimal VatRate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? LineTotal,
    BillingLineOrigin Origin,
    BillingLineDecision Decision,
    bool ManuallyAdjusted,
    string? ChangeReason,
    BillingLineConflict Conflict,
    IReadOnlyList<string> AnomalyCodes,
    BillingBasisStatus BasisStatus,
    string? OrderNo,
    string? InvoiceNo,
    InvoiceStatus? InvoiceStatus);

public sealed record PilotFile(byte[] Content, string FileName, int Rows);

/// <summary>Filters of the trace; the same ones narrow the Excel file.</summary>
public sealed record PilotTraceFilter(Guid? PayerId, BillingGroup? Group, string? Anomaly, bool AnomaliesOnly);

/// <summary>
/// The line-by-line trace of a billing run (DEV-22), read-only. Paged by keyset (payer, line id) with the total of the whole
/// filter; the Excel export walks the same pages, so the file and the screen can never disagree. No record scope applies: billing
/// has none (permissions alone decide who sees billing).
/// </summary>
internal sealed class PilotTraceService(
    BillingDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    ICurrentUser currentUser,
    IRequestContext requestContext,
    TimeProvider time)
{
    public const int MaxExportRows = 50_000;
    public const string ContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    private const int ExportPageSize = 2_000;
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    // Member initialisers, not a constructor: the filters and the cursor are applied to this shape in SQL.
    private sealed class Source
    {
        public Guid LineId { get; init; }
        public Guid BasisId { get; init; }
        public Guid PayerId { get; init; }
        public BillingBasisStatus BasisStatus { get; init; }
        public string? OrderNo { get; init; }
        public string? AnomaliesJson { get; init; }
        public BillingGroup Group { get; init; }
        public Guid? ProductId { get; init; }
        public string? ProductCode { get; init; }
        public string Description { get; init; } = string.Empty;
        public string? SourceKey { get; init; }
        public Guid? SourceOrganizationId { get; init; }
        public decimal Quantity { get; init; }
        public decimal UnitPrice { get; init; }
        public decimal DiscountPct { get; init; }
        public decimal VatRate { get; init; }
        public decimal LineTotal { get; init; }
        public BillingLineOrigin Origin { get; init; }
        public BillingLineDecision Decision { get; init; }
        public bool ManuallyAdjusted { get; init; }
        public string? ChangeReason { get; init; }
        public BillingLineConflict Conflict { get; init; }
    }

    public async Task<Result<PagedResult<PilotTraceRow>>> PageAsync(Guid runId, PilotTraceFilter filter, string? cursor, int? limit, CancellationToken ct)
    {
        if (await db.BillingRuns.AsNoTracking().Where(r => r.Id == runId).Select(r => new { r.PeriodStart, r.PeriodEnd }).SingleOrDefaultAsync(ct) is not { } run)
        {
            return BillingErrors.RunNotFound(runId);
        }

        if (!ValidFilter(filter))
        {
            return Error.Validation("BIL_PILOT_FILTER_INVALID", "The anomaly code may hold letters, digits, underscore, dot and hyphen only.");
        }

        var query = Filtered(runId, filter);
        var total = await query.CountAsync(ct);
        var take = KeysetCursor.ClampLimit(limit);
        var page = await After(query, KeysetCursor.Decode(cursor)).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var items = await EnrichAsync(rows, run.PeriodStart, run.PeriodEnd, runId, ct);
        var next = page.Count > take && rows.Count > 0
            ? new KeysetCursor(rows[^1].PayerId.ToString("D", CultureInfo.InvariantCulture), rows[^1].LineId).Encode()
            : null;
        return new PagedResult<PilotTraceRow>(items, next, total);
    }

    public async Task<Result<PilotFile>> ExportAsync(Guid runId, PilotTraceFilter filter, string? language, CancellationToken ct)
    {
        if (await db.BillingRuns.AsNoTracking().SingleOrDefaultAsync(r => r.Id == runId, ct) is not { } run)
        {
            return BillingErrors.RunNotFound(runId);
        }

        if (!ValidFilter(filter))
        {
            return Error.Validation("BIL_PILOT_FILTER_INVALID", "The anomaly code may hold letters, digits, underscore, dot and hyphen only.");
        }

        var query = Filtered(runId, filter);
        var count = await query.CountAsync(ct);
        if (count > MaxExportRows)
        {
            return Error.Validation("EXPORT_TOO_LARGE", $"The export would contain {count} rows. Narrow the filters to at most {MaxExportRows}.");
        }

        var money = currentUser.HasPermission(Permissions.FinanceRead);
        var headers = TraceHeaders.For(language);
        using var workbook = new XLWorkbook();
        var sheet = workbook.AddWorksheet(headers.Sheet);
        var columns = headers.Columns(money);
        for (var c = 0; c < columns.Count; c++)
        {
            sheet.Cell(1, c + 1).Value = columns[c];
        }

        var rowNumber = 2;
        KeysetCursor? after = null;
        while (true)
        {
            var batch = await After(query, after).Take(ExportPageSize).ToListAsync(ct);
            if (batch.Count == 0)
            {
                break;
            }

            foreach (var row in await EnrichAsync(batch, run.PeriodStart, run.PeriodEnd, runId, ct))
            {
                WriteRow(sheet, rowNumber++, row, money);
            }

            after = new KeysetCursor(batch[^1].PayerId.ToString("D", CultureInfo.InvariantCulture), batch[^1].LineId);
            if (batch.Count < ExportPageSize)
            {
                break;
            }
        }

        var info = workbook.AddWorksheet(headers.InfoSheet);
        var now = TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime;
        (string Label, object? Value)[] facts =
        [
            (headers.RunId, run.Id.ToString("D", CultureInfo.InvariantCulture)),
            (headers.Period, run.PeriodStart.ToString("yyyy-MM", CultureInfo.InvariantCulture)),
            (headers.Status, run.Status.ToString()),
            (headers.Revision, run.ContentRevision),
            (headers.ApprovedDigest, run.ApprovedDigest ?? string.Empty),
            (headers.Rows, rowNumber - 2),
            (headers.Generated, now),
            (headers.Money, money ? headers.Included : headers.Omitted),
        ];
        for (var i = 0; i < facts.Length; i++)
        {
            info.Cell(i + 1, 1).Value = facts[i].Label;
            switch (facts[i].Value)
            {
                case DateTime date:
                    info.Cell(i + 1, 2).Value = date;
                    info.Cell(i + 1, 2).Style.DateFormat.Format = "dd.MM.yyyy HH:mm";
                    break;
                case int number:
                    info.Cell(i + 1, 2).Value = number;
                    break;
                default:
                    info.Cell(i + 1, 2).Value = facts[i].Value?.ToString() ?? string.Empty;
                    info.Cell(i + 1, 2).Style.NumberFormat.Format = "@";
                    break;
            }
        }

        info.Columns().AdjustToContents(1, 20, 8, 80);

        var table = sheet.Range(1, 1, Math.Max(rowNumber - 1, 1), columns.Count).CreateTable("Trace");
        table.Theme = XLTableTheme.TableStyleLight9;
        sheet.SheetView.FreezeRows(1);
        sheet.Columns().AdjustToContents(1, Math.Min(rowNumber - 1, 200), 8, 60);

        using var stream = new MemoryStream();
        workbook.SaveAs(stream);

        // Ids and counts only: no description, reason or amount is copied into the trail.
        db.RecordAudit(currentUser, requestContext, time, AuditActions.Export, "BillingRunTrace", run.Id, new
        {
            RunId = run.Id,
            run.ContentRevision,
            Filters = new { filter.PayerId, Group = filter.Group?.ToString(), filter.Anomaly, filter.AnomaliesOnly },
            Rows = rowNumber - 2,
            MoneyIncluded = money,
        });
        await db.SaveChangesAsync(ct);

        var fileName = $"billing-trace-{run.PeriodStart:yyyy-MM}-{run.Id.ToString("N", CultureInfo.InvariantCulture)[..8]}.xlsx";
        return new PilotFile(stream.ToArray(), fileName, rowNumber - 2);
    }

    private static bool ValidFilter(PilotTraceFilter filter) =>
        filter.Anomaly is null || (filter.Anomaly.Length is > 0 and <= 64 &&
                                   filter.Anomaly.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-'));

    private IQueryable<Source> Filtered(Guid runId, PilotTraceFilter filter)
    {
        var query =
            from line in db.BillingLines.AsNoTracking()
            join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
            where basis.RunId == runId
            select new Source
            {
                LineId = line.Id,
                BasisId = basis.Id,
                PayerId = basis.OrganizationId,
                BasisStatus = basis.Status,
                OrderNo = basis.OrderNo,
                AnomaliesJson = basis.AnomaliesJson,
                Group = line.Group,
                ProductId = line.ProductId,
                ProductCode = line.ProductCode,
                Description = line.Description,
                SourceKey = line.SourceKey,
                SourceOrganizationId = line.SourceOrganizationId,
                Quantity = line.Quantity,
                UnitPrice = line.UnitPrice,
                DiscountPct = line.DiscountPct,
                VatRate = line.VatRate,
                LineTotal = line.LineTotal,
                Origin = line.Origin,
                Decision = line.Decision,
                ManuallyAdjusted = line.ManuallyAdjusted,
                ChangeReason = line.ChangeReason,
                Conflict = line.Conflict,
            };
        if (filter.PayerId is { } payer)
        {
            query = query.Where(s => s.PayerId == payer);
        }

        if (filter.Group is { } group)
        {
            query = query.Where(s => s.Group == group);
        }

        if (filter.Anomaly is { } code)
        {
            // The anomalies are stored as JSON; the code is validated to a safe alphabet, so the pattern cannot widen.
            var pattern = $"\"Code\":\"{code}\"";
            query = query.Where(s => s.AnomaliesJson != null && s.AnomaliesJson.Contains(pattern));
        }
        else if (filter.AnomaliesOnly)
        {
            query = query.Where(s => s.AnomaliesJson != null);
        }

        return query;
    }

    // Payer, then line id: the continuation mirrors the order, and the id breaks every tie.
    private static IQueryable<Source> After(IQueryable<Source> query, KeysetCursor? cursor)
    {
        if (cursor is not null && Guid.TryParse(cursor.SortKey, out var payer))
        {
            var id = cursor.Id;
            query = query.Where(s => s.PayerId.CompareTo(payer) > 0 || (s.PayerId == payer && s.LineId.CompareTo(id) > 0));
        }

        return query.OrderBy(s => s.PayerId).ThenBy(s => s.LineId);
    }

    private async Task<IReadOnlyList<PilotTraceRow>> EnrichAsync(
        IReadOnlyList<Source> rows, DateOnly periodStart, DateOnly periodEnd, Guid runId, CancellationToken ct)
    {
        if (rows.Count == 0)
        {
            return [];
        }

        var organizationIds = rows.Select(r => r.PayerId)
            .Concat(rows.Where(r => r.SourceOrganizationId is not null).Select(r => r.SourceOrganizationId!.Value))
            .Distinct().ToList();
        var names = await customers.GetOrganizationNamesAsync(organizationIds, ct);
        var numbers = await customers.GetOrgNumbersAsync(rows.Select(r => r.PayerId).Distinct().ToList(), ct);
        var products = await catalog.GetProductsAsync(rows.Where(r => r.ProductId is not null).Select(r => r.ProductId!.Value).Distinct().ToList(), ct);
        var basisIds = rows.Select(r => r.BasisId).Distinct().ToList();
        var invoiceRows = await db.Invoices.AsNoTracking()
            .Where(i => i.BasisId != null && basisIds.Contains(i.BasisId.Value))
            .Select(i => new { BasisId = i.BasisId!.Value, i.InvoiceNo, i.Status, i.InvoiceDate, i.Id })
            .ToListAsync(ct);
        var invoices = invoiceRows
            .GroupBy(i => i.BasisId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(i => i.InvoiceDate).ThenByDescending(i => i.Id).First());
        var anomalyCache = new Dictionary<Guid, IReadOnlyList<string>>();

        IReadOnlyList<string> CodesOf(Source s)
        {
            if (!anomalyCache.TryGetValue(s.BasisId, out var codes))
            {
                codes = s.AnomaliesJson is null
                    ? []
                    : (JsonSerializer.Deserialize<List<BillingAnomaly>>(s.AnomaliesJson) ?? []).Select(a => a.Code).Distinct(StringComparer.Ordinal).ToList();
                anomalyCache[s.BasisId] = codes;
            }

            return codes;
        }

        return rows.Select(s =>
        {
            invoices.TryGetValue(s.BasisId, out var invoice);
            return new PilotTraceRow(
                s.LineId,
                s.BasisId,
                runId,
                new RefDto(s.PayerId, names.GetValueOrDefault(s.PayerId, "—")),
                numbers.GetValueOrDefault(s.PayerId),
                s.SourceOrganizationId is { } source && source != s.PayerId ? new RefDto(source, names.GetValueOrDefault(source, "—")) : null,
                s.Group,
                s.ProductCode ?? (s.ProductId is { } pid ? products.GetValueOrDefault(pid)?.Sku : null),
                s.Description,
                s.SourceKey,
                periodStart,
                periodEnd,
                s.Quantity,
                s.UnitPrice,
                s.DiscountPct,
                s.VatRate,
                s.LineTotal,
                s.Origin,
                s.Decision,
                s.ManuallyAdjusted,
                s.ChangeReason,
                s.Conflict,
                CodesOf(s),
                s.BasisStatus,
                s.OrderNo,
                invoice?.InvoiceNo,
                invoice?.Status);
        }).ToList();
    }

    private static void WriteRow(IXLWorksheet sheet, int row, PilotTraceRow line, bool money)
    {
        var column = 1;

        void Text(string? value)
        {
            var cell = sheet.Cell(row, column++);
            if (value is null)
            {
                return;
            }

            // Text stays text (org numbers, codes); a value that would be read as a formula keeps its quote prefix (F-G1-10).
            cell.Value = value;
            cell.Style.NumberFormat.Format = "@";
            if (CsvCell.LooksLikeFormula(value))
            {
                cell.Style.IncludeQuotePrefix = true;
            }
        }

        void Number(decimal? value, string format)
        {
            var cell = sheet.Cell(row, column++);
            if (value is { } number)
            {
                cell.Value = number;
                cell.Style.NumberFormat.Format = format;
            }
        }

        Text(line.Payer.Name);
        Text(line.PayerOrgNumber);
        Text(line.SourceOrganization?.Name);
        Text(line.Group.ToString());
        Text(line.ProductCode);
        Text(line.Description);
        Text(line.SourceKey);
        Text(line.PeriodStart.ToString("yyyy-MM", CultureInfo.InvariantCulture));
        Number(line.Quantity, "0.00");
        if (money)
        {
            Number(line.UnitPrice, "#,##0.00##");
            Number(line.DiscountPct, "0.00");
        }

        Number(line.VatRate, "0.00");
        if (money)
        {
            Number(line.LineTotal, "#,##0.00");
        }

        Text(line.Origin.ToString());
        Text(line.Decision.ToString());
        Text(line.ChangeReason);
        Text(line.Conflict.ToString());
        Text(string.Join(", ", line.AnomalyCodes));
        Text(line.OrderNo);
        Text(line.BasisStatus.ToString());
        Text(line.InvoiceNo);
        Text(line.InvoiceStatus?.ToString());
    }
}

internal sealed record TraceHeaders(
    string Sheet, string InfoSheet, string Payer, string OrgNumber, string SourceCustomer, string Group, string ProductCode, string Description,
    string SourceKey, string Period, string Quantity, string UnitPrice, string Discount, string Vat, string LineTotal, string Origin, string Decision,
    string ChangeReason, string Conflict, string Anomalies, string OrderNo, string BasisStatus, string InvoiceNo, string InvoiceStatus,
    string RunId, string Status, string Revision, string ApprovedDigest, string Rows, string Generated, string Money, string Included, string Omitted)
{
    public IReadOnlyList<string> Columns(bool money)
    {
        var columns = new List<string> { Payer, OrgNumber, SourceCustomer, Group, ProductCode, Description, SourceKey, Period, Quantity };
        if (money)
        {
            columns.Add(UnitPrice);
            columns.Add(Discount);
        }

        columns.Add(Vat);
        if (money)
        {
            columns.Add(LineTotal);
        }

        columns.AddRange([Origin, Decision, ChangeReason, Conflict, Anomalies, OrderNo, BasisStatus, InvoiceNo, InvoiceStatus]);
        return columns;
    }

    private static readonly TraceHeaders Norwegian = new(
        "Sporing", "Kjøring", "Betaler", "Organisasjonsnummer", "Kunde tjenesten leveres til", "Gruppe", "Produktkode", "Beskrivelse",
        "Kildenøkkel", "Periode", "Antall", "Enhetspris", "Rabatt %", "MVA %", "Linjesum eks. MVA", "Opphav", "Beslutning",
        "Begrunnelse", "Konflikt", "Avvik", "Ordrenr.", "Grunnlagets status", "Fakturanr.", "Fakturastatus",
        "Kjøring-id", "Status", "Innholdsversjon", "Godkjent sammendrag", "Linjer", "Laget", "Beløp", "Med", "Utelatt (ingen rett til økonomi)");

    private static readonly TraceHeaders English = new(
        "Trace", "Run", "Payer", "Organization number", "Customer the service is delivered to", "Group", "Product code", "Description",
        "Source key", "Period", "Quantity", "Unit price", "Discount %", "VAT %", "Line total ex. VAT", "Origin", "Decision",
        "Change reason", "Conflict", "Anomalies", "Order no.", "Basis status", "Invoice no.", "Invoice status",
        "Run id", "Status", "Content revision", "Approved digest", "Lines", "Generated", "Amounts", "Included", "Omitted (no finance right)");

    private static readonly TraceHeaders Russian = new(
        "Трассировка", "Запуск", "Плательщик", "Оргномер", "Клиент, которому оказана услуга", "Группа", "Код продукта", "Описание",
        "Ключ источника", "Период", "Количество", "Цена за единицу", "Скидка %", "НДС %", "Сумма строки без НДС", "Происхождение", "Решение",
        "Причина изменения", "Конфликт", "Отклонения", "№ заказа", "Статус основания", "№ счёта", "Статус счёта",
        "Id запуска", "Статус", "Версия содержимого", "Утверждённый хэш", "Строк", "Создано", "Суммы", "Включены", "Опущены (нет права finance)");

    public static TraceHeaders For(string? language) => language switch
    {
        "en" => English,
        "ru" => Russian,
        _ => Norwegian,
    };
}
