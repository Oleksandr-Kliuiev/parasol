using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Security.Contracts;
using Crm.Service.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Billing.Features;

/// <summary>How a counted source stands against the customer's contract (M43).</summary>
public enum ServiceQuantityStatus
{
    /// <summary>The source counts nothing and no line bills it.</summary>
    None,

    /// <summary>A line bills it and the source counted it: the next basis bills the count.</summary>
    Counted,

    /// <summary>A line bills it, but the source has no count: the next basis bills the line's estimate and says so.</summary>
    NoReading,

    /// <summary>The source counts it, but no line bills it per unit (it may be in a fixed price: Finance decides).</summary>
    NotOnContract,
}

/// <summary>A line of a contract in force today that bills a counted source; <paramref name="Estimate"/> is the line's own quantity.</summary>
public sealed record ServiceQuantityLine(
    Guid ContractId, string ContractNumber, Guid LineId, string ProductName, string? DeviceFilter, decimal Estimate, decimal Billed, DateOnly ValidFrom,
    DateOnly? ValidTo);

/// <summary>
/// One line of what CloudAlly bills the partner for the customer: cost data, so price and total only for finance.cost.read.
/// <paramref name="Users"/> is how many users the line bills, as the billing basis counts them (<see cref="BackupBillCounts.Users"/>).
/// </summary>
public sealed record ServiceBillLine(
    DateOnly Day,
    string Account,
    string? AccountName,
    string? Service,
    string Source,
    int? Seats,
    int? Accounts,
    int? Users,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? Price,
    [property: SensitiveData(Permissions.FinanceCostRead)] decimal? Total,
    string? Currency);

/// <summary>
/// One counted source of a customer: what it counts now (with the day of the reading, and whether that is older than the billing's
/// limit), the contract lines that bill it and the quantity the next basis would take for each, and the source's own bill lines.
/// </summary>
public sealed record ServiceQuantity(
    QuantityModel Model,
    string Source,
    int? Count,
    IReadOnlyDictionary<string, int>? Detail,
    DateOnly? ReadOn,
    bool Stale,
    ServiceQuantityStatus Status,
    IReadOnlyList<ServiceQuantityLine> Lines,
    IReadOnlyList<ServiceBillLine> BillLines);

public sealed record ServiceQuantities(Guid OrganizationId, DateOnly AsOf, int StaleQuantityDays, IReadOnlyList<ServiceQuantity> Services);

/// <summary>
/// "Money" of M43 for one customer: the Atera devices, Huntress agents and CloudAlly seats as billing counts them today, side by side
/// with the contract lines in force that bill them — the same readings and rule the collector uses (<see cref="BillingQuantities"/>),
/// so the card shows what the next basis would bill — and the bill lines CloudAlly charged the partner (M42 stored them, nothing
/// showed them). From saved data only.
/// </summary>
internal sealed class ServiceQuantityReader(
    IContractsApi contracts,
    ICatalogApi catalog,
    IServiceApi service,
    ISecurityApi security,
    IBackupApi backup,
    TimeProvider time,
    IOptions<BillingOptions> options)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private static readonly (QuantityModel Model, string Source)[] Sources =
    [
        (QuantityModel.PerAteraDevice, "atera"),
        (QuantityModel.PerHuntressAgent, SecuritySources.Huntress),
        (QuantityModel.PerBackupSeat, BackupSources.CloudAlly),
    ];

    public async Task<ServiceQuantities> ReadAsync(Guid organizationId, CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        var staleDays = options.Value.StaleQuantityDays;
        var lines = (await contracts.GetBillableLinesAsync(organizationId, today, today, ct))
            .Where(l => Sources.Any(s => s.Model == l.QuantityModel))
            .ToList();
        var products = await catalog.GetProductsAsync(lines.Select(l => l.ProductId).Distinct().ToList(), ct);
        // Every source of the customer is read, whichever lines it has: one that counts what no line bills is worth saying.
        var quantities = await BillingQuantities.ReadCustomerAsync(organizationId, today, staleDays, service, security, backup, ct);
        var bills = await backup.GetBillLinesAsync(BackupSources.CloudAlly, organizationId, today, ct);

        var result = new List<ServiceQuantity>();
        foreach (var (model, source) in Sources)
        {
            var reading = quantities.ReadingOf(model, organizationId);
            var mine = lines.Where(l => l.QuantityModel == model).ToList();
            var status = mine.Count > 0
                ? reading.Count is null ? ServiceQuantityStatus.NoReading : ServiceQuantityStatus.Counted
                : reading.Count is > 0 ? ServiceQuantityStatus.NotOnContract : ServiceQuantityStatus.None;
            result.Add(new ServiceQuantity(
                model,
                source,
                reading.Count,
                model == QuantityModel.PerAteraDevice && quantities.DevicesOf(organizationId) is { } devices
                    ? devices.Where(c => c.Value > 0).ToDictionary(c => c.Key.ToString(), c => c.Value)
                    : null,
                reading.Day,
                reading.Day is { } day && today.DayNumber - day.DayNumber > staleDays,
                status,
                [.. mine.Select(l => new ServiceQuantityLine(
                    l.ContractId, l.ContractNumber, l.LineId, products.GetValueOrDefault(l.ProductId)?.Name ?? "?",
                    l.QuantityModel == QuantityModel.PerAteraDevice ? l.DeviceFilter.ToString() : null, l.Quantity,
                    quantities.QuantityOf(l, products.GetValueOrDefault(l.ProductId), []), l.LineValidFrom, l.LineValidTo))],
                model == QuantityModel.PerBackupSeat
                    ? [.. bills.Select(b => new ServiceBillLine(b.Day, b.AccountExternalId, b.AccountName, b.Service, b.Source, b.Seats, b.Accounts,
                        BackupBillCounts.Users(b.Seats, b.Accounts), b.Price, b.Total, b.Currency))]
                    : []));
        }

        return new ServiceQuantities(organizationId, today, staleDays, result);
    }
}
