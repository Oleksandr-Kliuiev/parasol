using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>One agent of a machine as a list row names it: its source, when it was last in touch and its link at the source.</summary>
public sealed record MachineSourceItem(Guid DeviceId, string System, bool Online, DateTimeOffset? LastSeenAt, string? Url);

/// <summary>
/// One machine of a customer (M40): the computer, whichever sources watch it. <paramref name="OpenAlerts"/> counts the open alerts of
/// its devices, <paramref name="Proposals"/> the other machines a person should compare it with.
/// </summary>
public sealed record MachineItem(
    Guid Id,
    Guid OrganizationId,
    string Name,
    DeviceType Type,
    string? Os,
    bool Online,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? RemovedAt,
    IReadOnlyList<MachineSourceItem> Sources,
    int OpenAlerts,
    int Proposals);

/// <summary>One agent of a machine in its card, with the keys that tell machines apart.</summary>
public sealed record MachineDeviceItem(
    Guid Id,
    string System,
    string ExternalId,
    string MachineName,
    DeviceType Type,
    string? Os,
    bool Online,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset FirstSeenAt,
    DateTimeOffset? RemovedAt,
    string? Url,
    string? SerialNumber,
    IReadOnlyList<string> MacAddresses);

/// <summary>
/// Another machine of the customer that may be the same computer, and why: <c>serial</c>, <c>mac</c>, <c>name</c>, and
/// <c>serialConflict</c> when both carry a serial number and the numbers differ.
/// </summary>
public sealed record MachineProposalItem(Guid OtherMachineId, string OtherName, IReadOnlyList<string> Evidence, DateTimeOffset FoundAt);

/// <summary>A machine's card: its devices (current ones first), the proposals about it and its open alerts.</summary>
public sealed record MachineDetail(
    Guid Id,
    Guid OrganizationId,
    string? OrganizationName,
    string Name,
    DeviceType Type,
    string? Os,
    bool Online,
    DateTimeOffset? LastSeenAt,
    DateTimeOffset? RemovedAt,
    IReadOnlyList<MachineDeviceItem> Devices,
    IReadOnlyList<MachineProposalItem> Proposals,
    int OpenAlerts,
    string Etag);

/// <summary>The machines of a customer and one machine's card (M40).</summary>
internal sealed class MachineQueries(ServiceDbContext db, ICustomersApi customers)
{
    public const int DefaultLimit = 25;
    public const int MaxLimit = 100;

    /// <summary>
    /// A customer's machines by name, then id, current ones unless asked otherwise; facts about the page's machines are read in one
    /// batch per kind, never per row (DEV-12).
    /// </summary>
    public async Task<Result<PagedResult<MachineItem>>> ListAsync(
        Guid organizationId, DeviceType? type, bool includeRemoved, string? search, string? cursor, int? limit, CancellationToken ct)
    {
        if (type is { } t && !Enum.IsDefined(t))
        {
            return Error.Validation("SRV_MACHINE_FILTER_INVALID", "Unknown device type.");
        }

        var after = KeysetCursor.Decode(cursor);
        if (cursor is not null && after is null)
        {
            return Error.Validation("SRV_MACHINE_CURSOR_INVALID", "The machine page does not belong to this list.");
        }

        var machines = db.Machines.AsNoTracking().Where(m => m.OrganizationId == organizationId);
        if (!includeRemoved)
        {
            machines = machines.Where(m => m.RemovedAt == null);
        }

        if (type is { } wanted)
        {
            machines = machines.Where(m => m.Type == wanted);
        }

        if (search?.Trim() is { Length: > 0 } term)
        {
            machines = machines.Where(m => m.Name.Contains(term));
        }

        var total = await machines.CountAsync(ct);
        if (after is not null)
        {
            machines = machines.Where(m => m.Name.CompareTo(after.SortKey) > 0 || (m.Name == after.SortKey && m.Id.CompareTo(after.Id) > 0));
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await machines.OrderBy(m => m.Name).ThenBy(m => m.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var ids = rows.Select(m => m.Id).ToList();
        var sources = await SourcesAsync(ids, ct);
        var alerts = await OpenAlertsAsync(ids, ct);
        var proposals = await ProposalCountsAsync(ids, ct);
        var items = rows.Select(m => new MachineItem(
            m.Id, m.OrganizationId, m.Name, m.Type, m.Os, m.Online, m.LastSeenAt, m.RemovedAt,
            sources.GetValueOrDefault(m.Id) ?? [], alerts.GetValueOrDefault(m.Id), proposals.GetValueOrDefault(m.Id))).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].Name, rows[^1].Id).Encode() : null;
        return new PagedResult<MachineItem>(items, next, total);
    }

    /// <summary>One machine's card; the ETag is the one a person's decision about it must send.</summary>
    public async Task<Result<MachineDetail>> GetAsync(Guid id, CancellationToken ct)
    {
        if (await db.Machines.SingleOrDefaultAsync(m => m.Id == id, ct) is not { } machine)
        {
            return MachineErrors.NotFound;
        }

        var devices = await db.Devices.AsNoTracking().Where(d => d.MachineId == id)
            .OrderBy(d => d.RemovedAt == null ? 0 : 1).ThenBy(d => d.System).ThenBy(d => d.FirstSeenAt).ThenBy(d => d.Id)
            .ToListAsync(ct);
        var proposals = await db.MachineProposals.AsNoTracking().Where(p => p.MachineId == id || p.OtherMachineId == id).ToListAsync(ct);
        var otherIds = proposals.Select(p => p.MachineId == id ? p.OtherMachineId : p.MachineId).Distinct().ToList();
        var names = await db.Machines.AsNoTracking().Where(m => otherIds.Contains(m.Id)).ToDictionaryAsync(m => m.Id, m => m.Name, ct);
        var organization = await customers.GetOrganizationNamesAsync([machine.OrganizationId], ct);
        var alerts = await OpenAlertsAsync([id], ct);
        return new MachineDetail(
            machine.Id, machine.OrganizationId, organization.GetValueOrDefault(machine.OrganizationId), machine.Name, machine.Type, machine.Os,
            machine.Online, machine.LastSeenAt, machine.RemovedAt,
            devices.Select(d => new MachineDeviceItem(
                d.Id, d.System, d.ExternalId, d.MachineName, d.Type, d.Os, d.Online, d.LastSeenAt, d.FirstSeenAt, d.RemovedAt, d.Url,
                d.SerialNumber, d.MacAddressList)).ToList(),
            proposals.Select(p => (Proposal: p, Other: p.MachineId == id ? p.OtherMachineId : p.MachineId))
                .Where(p => names.ContainsKey(p.Other))
                .OrderBy(p => p.Proposal.FoundAt).ThenBy(p => p.Other)
                .Select(p => new MachineProposalItem(p.Other, names[p.Other], Evidence(p.Proposal.Evidence), p.Proposal.FoundAt)).ToList(),
            alerts.GetValueOrDefault(id),
            db.GetETag(machine));
    }

    /// <summary>The words of the evidence, strongest first.</summary>
    internal static IReadOnlyList<string> Evidence(MachineEvidence evidence)
    {
        var words = new List<string>(4);
        if (evidence.HasFlag(MachineEvidence.Serial))
        {
            words.Add("serial");
        }

        if (evidence.HasFlag(MachineEvidence.Mac))
        {
            words.Add("mac");
        }

        if (evidence.HasFlag(MachineEvidence.Name))
        {
            words.Add("name");
        }

        if (evidence.HasFlag(MachineEvidence.SerialConflict))
        {
            words.Add("serialConflict");
        }

        return words;
    }

    private async Task<Dictionary<Guid, IReadOnlyList<MachineSourceItem>>> SourcesAsync(List<Guid> machineIds, CancellationToken ct)
    {
        if (machineIds.Count == 0)
        {
            return [];
        }

        var devices = await db.Devices.AsNoTracking().Where(d => d.MachineId != null && machineIds.Contains(d.MachineId.Value) && d.RemovedAt == null)
            .OrderBy(d => d.System).ThenBy(d => d.FirstSeenAt).ThenBy(d => d.Id)
            .Select(d => new { MachineId = d.MachineId!.Value, Item = new MachineSourceItem(d.Id, d.System, d.Online, d.LastSeenAt, d.Url) })
            .ToListAsync(ct);
        return devices.GroupBy(d => d.MachineId).ToDictionary(g => g.Key, g => (IReadOnlyList<MachineSourceItem>)g.Select(d => d.Item).ToList());
    }

    /// <summary>Open alerts of the machines' devices, current or not: an alert of a device no longer reported is still open.</summary>
    private async Task<Dictionary<Guid, int>> OpenAlertsAsync(List<Guid> machineIds, CancellationToken ct) =>
        machineIds.Count == 0
            ? []
            : await (from alert in db.Alerts.AsNoTracking()
                     join device in db.Devices.AsNoTracking() on alert.DeviceId equals device.Id
                     where alert.State == AlertState.Open && device.MachineId != null && machineIds.Contains(device.MachineId.Value)
                     group alert by device.MachineId!.Value into g
                     select new { g.Key, Count = g.Count() })
                .ToDictionaryAsync(g => g.Key, g => g.Count, ct);

    private async Task<Dictionary<Guid, int>> ProposalCountsAsync(List<Guid> machineIds, CancellationToken ct)
    {
        if (machineIds.Count == 0)
        {
            return [];
        }

        var pairs = await db.MachineProposals.AsNoTracking()
            .Where(p => machineIds.Contains(p.MachineId) || machineIds.Contains(p.OtherMachineId))
            .Select(p => new { p.MachineId, p.OtherMachineId }).ToListAsync(ct);
        return pairs.SelectMany(p => new[] { p.MachineId, p.OtherMachineId }).Where(machineIds.Contains)
            .GroupBy(id => id).ToDictionary(g => g.Key, g => g.Count());
    }
}

/// <summary>The errors of the machine endpoints (M40).</summary>
internal static class MachineErrors
{
    public static Error NotFound { get; } = Error.NotFound("SRV_MACHINE_NOT_FOUND", "The machine is not stored in the CRM.");

    public static Error Stale { get; } = Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The machine changed. Read it again and decide again.");
}
