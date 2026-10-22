using System.Globalization;
using Crm.Backup.Contracts;
using Crm.Billing.Domain;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Licensing.Contracts;
using Crm.Security.Contracts;
using Crm.Service.Contracts;

namespace Crm.Billing.Features;

/// <summary>
/// The counted quantities of one billing run (BR-CON-02, DEV-16, DEV-19): read once for the run's customers — the CSP subscriptions of
/// the portfolio, Microsoft 365 licence readings, Atera device counts, and since M43 the agents Huntress bills and the seats CloudAlly
/// bills, each from the last day read on or before the period's end — and asked per contract line. A line's quantity is what its
/// source counted; without a reading the contract's estimate is billed and the basis says so, and a reading older than
/// <c>Billing:StaleQuantityDays</c> before the end of the period is billed as it is and says so too. Nothing here blocks a basis:
/// Finance decides whether an estimated one may be billed.
/// </summary>
internal sealed class BillingQuantities
{
    private readonly IReadOnlyDictionary<Guid, List<SubscriptionQuantity>> _subscriptions;
    private readonly IReadOnlyDictionary<(Guid OrganizationId, Guid ProductId), AssignedLicenses> _assigned;
    private readonly IReadOnlyDictionary<Guid, DeviceCountReading> _devices;
    private readonly IReadOnlyDictionary<Guid, AgentCountReading> _agents;
    private readonly IReadOnlyDictionary<Guid, SeatCountReading> _seats;
    private readonly DateOnly _reference;
    private readonly int _staleDays;

    private BillingQuantities(
        IReadOnlyDictionary<Guid, List<SubscriptionQuantity>> subscriptions,
        IReadOnlyDictionary<(Guid OrganizationId, Guid ProductId), AssignedLicenses> assigned,
        IReadOnlyDictionary<Guid, DeviceCountReading> devices,
        IReadOnlyDictionary<Guid, AgentCountReading> agents,
        IReadOnlyDictionary<Guid, SeatCountReading> seats,
        DateOnly reference,
        int staleDays)
    {
        _subscriptions = subscriptions;
        _assigned = assigned;
        _devices = devices;
        _agents = agents;
        _seats = seats;
        _reference = reference;
        _staleDays = staleDays;
    }

    /// <summary>
    /// Reads what the run's lines count, once for all of their customers. The subscriptions come from the portfolio read the collector
    /// makes anyway (DEV-16); a reading is as old as the day it was taken, measured from <paramref name="reference"/> — the end of the
    /// period, or today while the period is not over.
    /// </summary>
    public static async Task<BillingQuantities> ReadAsync(
        IReadOnlyList<BillableContractLine> lines,
        IReadOnlyList<SubscriptionQuantity> subscriptions,
        DateOnly periodEnd,
        DateOnly reference,
        int staleDays,
        ILicensingApi licensing,
        IServiceApi service,
        ISecurityApi security,
        IBackupApi backup,
        CancellationToken ct)
    {
        // Each reading is asked only for the customers whose lines use its model.
        var assigned = (await licensing.GetAssignedLicensesAsync(OrganizationsOf(lines, QuantityModel.PerM365User), periodEnd, ct))
            .ToDictionary(a => (a.OrganizationId, a.ProductId), a => a);
        var devices = await service.GetDeviceCountReadingsAsync(OrganizationsOf(lines, QuantityModel.PerAteraDevice), periodEnd, ct);
        var agents = await security.GetAgentCountReadingsAsync(SecuritySources.Huntress, OrganizationsOf(lines, QuantityModel.PerHuntressAgent), periodEnd, ct);
        var seats = await backup.GetSeatCountReadingsAsync(BackupSources.CloudAlly, OrganizationsOf(lines, QuantityModel.PerBackupSeat), periodEnd, ct);
        return new BillingQuantities(
            subscriptions.GroupBy(s => s.OrganizationId).ToDictionary(g => g.Key, g => g.ToList()), assigned, devices, agents, seats, reference, staleDays);
    }

    /// <summary>
    /// The counted sources of one customer on a day (M43, the card's reconciliation with its contract): its Atera devices, Huntress agents
    /// and CloudAlly seats, whichever lines it has, read the way a run reads them.
    /// </summary>
    public static async Task<BillingQuantities> ReadCustomerAsync(
        Guid organizationId, DateOnly date, int staleDays, IServiceApi service, ISecurityApi security, IBackupApi backup, CancellationToken ct)
    {
        Guid[] customer = [organizationId];
        return new BillingQuantities(
            new Dictionary<Guid, List<SubscriptionQuantity>>(), new Dictionary<(Guid, Guid), AssignedLicenses>(),
            await service.GetDeviceCountReadingsAsync(customer, date, ct),
            await security.GetAgentCountReadingsAsync(SecuritySources.Huntress, customer, date, ct),
            await backup.GetSeatCountReadingsAsync(BackupSources.CloudAlly, customer, date, ct),
            date, staleDays);
    }

    /// <summary>
    /// What a counted model's source read for a customer (M43): the count — all devices for Atera — and the day it was read; a device
    /// count without a daily snapshot has no day (the devices listed now were counted).
    /// </summary>
    public (int? Count, DateOnly? Day) ReadingOf(QuantityModel model, Guid organizationId) => model switch
    {
        QuantityModel.PerAteraDevice when _devices.GetValueOrDefault(organizationId) is { } devices => (devices.Counts.Values.Sum(), devices.SnapshotDate),
        QuantityModel.PerHuntressAgent when _agents.GetValueOrDefault(organizationId) is { } agents => (agents.BillableAgents, agents.Day),
        QuantityModel.PerBackupSeat when _seats.GetValueOrDefault(organizationId) is { } seats => (seats.Seats, seats.Day),
        _ => (null, null),
    };

    /// <summary>A customer's Atera devices by type, as the device reading counted them; null without a reading.</summary>
    public IReadOnlyDictionary<DeviceType, int>? DevicesOf(Guid organizationId) => _devices.GetValueOrDefault(organizationId)?.Counts;

    /// <summary>The quantity a line is billed with, adding what its source lacks to <paramref name="anomalies"/>; 0 or less leaves the line out.</summary>
    public decimal QuantityOf(BillableContractLine line, ProductRef? product, List<BillingAnomaly> anomalies) => line.QuantityModel switch
    {
        QuantityModel.PerSubscription => SubscriptionQuantityOf(line, anomalies, product),
        QuantityModel.PerAteraDevice => DeviceQuantityOf(line),
        QuantityModel.PerM365User => M365UserQuantityOf(line, anomalies, product),
        QuantityModel.PerHuntressAgent => CountedQuantityOf(line, _agents.GetValueOrDefault(line.OrganizationId)?.BillableAgents, anomalies,
            "BIL_NO_AGENT_READING", product?.Name ?? "Product", "is billed per Huntress agent, but Huntress has not counted them for the customer; the contract estimate is used."),
        QuantityModel.PerBackupSeat => CountedQuantityOf(line, _seats.GetValueOrDefault(line.OrganizationId)?.Seats, anomalies,
            "BIL_NO_SEAT_READING", product?.Name ?? "Product", "is billed per backup seat, but no CloudAlly bill counts them for the customer; the contract estimate is used."),
        _ => line.Quantity,
    };

    /// <summary>The CSP subscriptions a per-subscription line is billed for, which travel with the basis line; null for other models.</summary>
    public IReadOnlyList<string>? SubscriptionIdsOf(BillableContractLine line) =>
        line.QuantityModel == QuantityModel.PerSubscription
            ? _subscriptions.GetValueOrDefault(line.OrganizationId)?.FirstOrDefault(s => s.ProductId == line.ProductId)?.SubscriptionIds
            : null;

    /// <summary>
    /// DEV-19: a quantity read long before the period ended, or counted from live devices because no snapshot exists, is billed
    /// as it is but says so on the basis. Asked for a line that is billed (its quantity is above 0).
    /// </summary>
    public void AddReadingAnomalies(BillableContractLine line, ProductRef? product, List<BillingAnomaly> anomalies)
    {
        var name = product?.Name ?? "Product";
        if (line.QuantityModel == QuantityModel.PerM365User && Assigned(line) is { Assigned: > 0 } assigned &&
            _reference.DayNumber - assigned.SnapshotDate.DayNumber > _staleDays)
        {
            AddOnce(anomalies, "BIL_STALE_QUANTITY", name, assigned.SnapshotDate,
                $"{name} is billed from a Microsoft 365 licence reading of {assigned.SnapshotDate:dd.MM.yyyy}, which is older than {_staleDays} days.");
        }

        if (line.QuantityModel == QuantityModel.PerHuntressAgent && _agents.GetValueOrDefault(line.OrganizationId) is { BillableAgents: not null } agents &&
            _reference.DayNumber - agents.Day.DayNumber > _staleDays)
        {
            AddOnce(anomalies, "BIL_STALE_QUANTITY", name, agents.Day,
                $"{name} is billed from a Huntress agent count of {agents.Day:dd.MM.yyyy}, which is older than {_staleDays} days.");
        }

        if (line.QuantityModel == QuantityModel.PerBackupSeat && _seats.GetValueOrDefault(line.OrganizationId) is { Seats: not null } seats &&
            _reference.DayNumber - seats.Day.DayNumber > _staleDays)
        {
            AddOnce(anomalies, "BIL_STALE_QUANTITY", name, seats.Day,
                $"{name} is billed from a CloudAlly seat count of {seats.Day:dd.MM.yyyy}, which is older than {_staleDays} days.");
        }

        if (line.QuantityModel != QuantityModel.PerAteraDevice)
        {
            return;
        }

        if (_devices.GetValueOrDefault(line.OrganizationId)?.SnapshotDate is not { } snapshot)
        {
            AddOnce(anomalies, "BIL_NO_DEVICE_SNAPSHOT", name, null,
                $"{name} is billed per device, but no daily device count exists; the devices listed now are counted.");
        }
        else if (_reference.DayNumber - snapshot.DayNumber > _staleDays)
        {
            AddOnce(anomalies, "BIL_STALE_QUANTITY", name, snapshot,
                $"{name} is billed from a device count of {snapshot:dd.MM.yyyy}, which is older than {_staleDays} days.");
        }
    }

    private static Guid[] OrganizationsOf(IReadOnlyList<BillableContractLine> lines, QuantityModel model) =>
        lines.Where(l => l.QuantityModel == model).Select(l => l.OrganizationId).Distinct().ToArray();

    private AssignedLicenses? Assigned(BillableContractLine line) => _assigned.GetValueOrDefault((line.OrganizationId, line.ProductId));

    private decimal DeviceQuantityOf(BillableContractLine line)
    {
        var counts = _devices.GetValueOrDefault(line.OrganizationId)?.Counts ?? new Dictionary<DeviceType, int>();
        return line.DeviceFilter switch
        {
            DeviceFilter.Workstations => counts.GetValueOrDefault(DeviceType.Workstation),
            DeviceFilter.Servers => counts.GetValueOrDefault(DeviceType.Server),
            _ => counts.Values.Sum(),
        };
    }

    /// <summary>
    /// A quantity a source counts (M43: Huntress agents, CloudAlly seats). Without a count the contract's estimate is billed and the
    /// basis says so, also when the estimate is 0 and the line is left out.
    /// </summary>
    private static decimal CountedQuantityOf(
        BillableContractLine line, int? counted, List<BillingAnomaly> anomalies, string code, string name, string what)
    {
        if (counted is { } count)
        {
            return count;
        }

        AddOnce(anomalies, code, name, null, $"{name} {what}");
        return line.Quantity;
    }

    private decimal SubscriptionQuantityOf(BillableContractLine line, List<BillingAnomaly> anomalies, ProductRef? product)
    {
        if (_subscriptions.GetValueOrDefault(line.OrganizationId)?.FirstOrDefault(s => s.ProductId == line.ProductId) is { } match)
        {
            return match.Quantity;
        }

        anomalies.Add(new BillingAnomaly(
            "BIL_NO_SUBSCRIPTION", $"{product?.Name ?? "Product"} is billed per subscription, but the customer has none; the contract quantity is used."));
        return line.Quantity;
    }

    /// <summary>
    /// BR-CON-02: the number of assigned licences in the customer's tenant (FR-LIC-03). Without a reading the contract's
    /// estimate is billed and the basis says so, so nobody silently invoices a guess.
    /// </summary>
    private decimal M365UserQuantityOf(BillableContractLine line, List<BillingAnomaly> anomalies, ProductRef? product)
    {
        if (Assigned(line) is not { } assigned)
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_ESTIMATED_QUANTITY", $"{product?.Name ?? "Product"} is billed per Microsoft 365 user; the contract estimate is used until the tenant is read."));
            return line.Quantity;
        }

        if (assigned.Assigned == 0)
        {
            anomalies.Add(new BillingAnomaly(
                "BIL_NO_ASSIGNED_LICENCES", $"{product?.Name ?? "Product"} is billed per Microsoft 365 user, but the tenant has none assigned ({assigned.SnapshotDate:dd.MM.yyyy})."));
            return line.Quantity;
        }

        return assigned.Assigned;
    }

    private static void AddOnce(List<BillingAnomaly> anomalies, string code, string product, DateOnly? date, string message)
    {
        var args = new Dictionary<string, string> { ["product"] = product };
        if (date is { } day)
        {
            args["date"] = day.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
        }

        if (!anomalies.Any(a => a.Code == code && a.Message == message))
        {
            anomalies.Add(new BillingAnomaly(code, message, args));
        }
    }
}
