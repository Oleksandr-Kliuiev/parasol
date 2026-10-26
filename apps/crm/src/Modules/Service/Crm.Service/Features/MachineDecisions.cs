using Crm.Infrastructure.Persistence;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// What a person decides about a customer's machines (M40): two machines are one computer, two are different computers, or a device
/// is not the computer it was put on. A decision is kept for the pairs of current devices it is about, so the matcher applies it
/// before any rule on every read; the customer's machines are matched again at once.
/// </summary>
internal sealed class MachineDecisions(ServiceDbContext db, TimeProvider time)
{
    /// <summary>The two machines are one computer: every pair of their current devices is "same". The older machine's id stays.</summary>
    public Task<Result<Guid>> JoinAsync(Guid machineId, Guid otherMachineId, string ifMatch, CancellationToken ct) =>
        PairAsync(machineId, otherMachineId, ifMatch, MachineLinkKind.Same, ct);

    /// <summary>The two machines are different computers: every pair of their current devices is "different", for good.</summary>
    public Task<Result<Guid>> KeepApartAsync(Guid machineId, Guid otherMachineId, string ifMatch, CancellationToken ct) =>
        PairAsync(machineId, otherMachineId, ifMatch, MachineLinkKind.Different, ct);

    /// <summary>The device is not this computer: it is kept apart from every other current device of the machine.</summary>
    public async Task<Result<Guid>> DetachAsync(Guid machineId, Guid deviceId, string ifMatch, CancellationToken ct)
    {
        var loaded = await LoadAsync(machineId, ifMatch, ct);
        if (!loaded.IsSuccess)
        {
            return loaded.Error!;
        }

        var machine = loaded.Value;
        var members = await CurrentDevicesAsync(machine, ct);
        if (!members.Contains(deviceId))
        {
            return Error.Validation("SRV_MACHINE_DEVICE_UNKNOWN", "The device is not a current device of this machine.");
        }

        if (members.Count < 2)
        {
            return Error.Validation("SRV_MACHINE_SINGLE_DEVICE", "The machine has no other device to tell this one apart from.");
        }

        await new MachineLinks(db, time).RunAsync(machine.OrganizationId, async c =>
        {
            await DecideAsync(machine.OrganizationId, members.Where(m => m != deviceId).Select(m => (deviceId, m)), MachineLinkKind.Different, c);
            // The device leaves; the machine the person looked at stays with the devices that remain.
            (await db.Devices.SingleAsync(d => d.Id == deviceId, c)).BelongTo(null);
        }, ct);
        return await MachineOfAsync(members.First(m => m != deviceId), ct);
    }

    private async Task<Result<Guid>> PairAsync(Guid machineId, Guid otherMachineId, string ifMatch, MachineLinkKind kind, CancellationToken ct)
    {
        var loaded = await LoadAsync(machineId, ifMatch, ct);
        if (!loaded.IsSuccess)
        {
            return loaded.Error!;
        }

        var machine = loaded.Value;
        var other = await db.Machines.AsNoTracking().SingleOrDefaultAsync(m => m.Id == otherMachineId, ct);
        if (other is null || other.Id == machine.Id || other.OrganizationId != machine.OrganizationId)
        {
            return Error.Validation("SRV_MACHINE_OTHER_INVALID", "Choose another machine of the same customer.");
        }

        var members = await CurrentDevicesAsync(machine, ct);
        var others = await CurrentDevicesAsync(other, ct);
        if (members.Count == 0 || others.Count == 0)
        {
            return Error.Validation("SRV_MACHINE_REMOVED", "A machine none of whose devices is reported any more cannot be matched.");
        }

        await new MachineLinks(db, time).RunAsync(machine.OrganizationId,
            c => DecideAsync(machine.OrganizationId, members.SelectMany(a => others.Select(b => (a, b))), kind, c), ct);
        return await MachineOfAsync(members[0], ct);
    }

    /// <summary>The machine as the person saw it: a decision about a machine that changed since is refused, to be read again.</summary>
    private async Task<Result<Machine>> LoadAsync(Guid machineId, string ifMatch, CancellationToken ct)
    {
        if (await db.Machines.SingleOrDefaultAsync(m => m.Id == machineId, ct) is not { } machine)
        {
            return MachineErrors.NotFound;
        }

        if (!db.ApplyIfMatch(machine, ifMatch))
        {
            return Error.Validation("SRV_MACHINE_ETAG_INVALID", "The If-Match header is not an ETag of this machine.");
        }

        return db.IsStale(machine) ? MachineErrors.Stale : machine;
    }

    private Task<List<Guid>> CurrentDevicesAsync(Machine machine, CancellationToken ct) =>
        db.Devices.AsNoTracking()
            .Where(d => d.MachineId == machine.Id && d.OrganizationId == machine.OrganizationId && d.RemovedAt == null)
            .OrderBy(d => d.FirstSeenAt).ThenBy(d => d.Id).Select(d => d.Id).ToListAsync(ct);

    /// <summary>Records the decision for every pair, changing a pair's earlier decision.</summary>
    private async Task DecideAsync(Guid organizationId, IEnumerable<(Guid, Guid)> pairs, MachineLinkKind kind, CancellationToken ct)
    {
        var wanted = pairs.Select(p => MachineLinkDecision.Order(p.Item1, p.Item2)).Distinct().ToList();
        var firsts = wanted.Select(p => p.First).Distinct().ToList();
        var existing = (await db.MachineLinkDecisions.Where(d => firsts.Contains(d.DeviceId)).ToListAsync(ct))
            .ToDictionary(d => (d.DeviceId, d.OtherDeviceId));
        foreach (var (first, second) in wanted)
        {
            if (existing.TryGetValue((first, second), out var decision))
            {
                decision.Decide(kind);
            }
            else
            {
                db.MachineLinkDecisions.Add(MachineLinkDecision.For(organizationId, first, second, kind));
            }
        }
    }

    private async Task<Result<Guid>> MachineOfAsync(Guid deviceId, CancellationToken ct)
    {
        db.ChangeTracker.Clear();
        return await db.Devices.AsNoTracking().Where(d => d.Id == deviceId).Select(d => d.MachineId).SingleOrDefaultAsync(ct) is { } machineId
            ? machineId
            : MachineErrors.NotFound;
    }
}
