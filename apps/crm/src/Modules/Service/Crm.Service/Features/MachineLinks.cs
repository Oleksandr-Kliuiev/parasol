using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// Stores what the machine matcher finds for one customer (M40): the machine of every current device, the machines' facts, the
/// machines no device needs any more and the proposals for a person. One customer at a time: a device read, a person's decision
/// and a run started by hand wait for each other instead of making the same new machine twice.
/// </summary>
internal sealed class MachineLinks(ServiceDbContext db, TimeProvider time)
{
    /// <summary>Matches the devices of each customer again, one transaction per customer.</summary>
    public async Task RelinkAsync(IEnumerable<Guid> organizationIds, CancellationToken cancellationToken)
    {
        foreach (var organizationId in organizationIds.Distinct())
        {
            await RunAsync(organizationId, _ => Task.CompletedTask, cancellationToken);
        }
    }

    /// <summary>
    /// Runs <paramref name="decide"/> (a person's decisions about the customer's devices) and the match it changes in one
    /// transaction under the customer's lock, then saves both.
    /// </summary>
    public Task RunAsync(Guid organizationId, Func<CancellationToken, Task> decide, CancellationToken cancellationToken)
    {
        var resource = "service-machines:" + organizationId.ToString("N");
        var attempt = 0;
        // The lock, the reads and the writes land together, and the SQL Server retry strategy needs the transaction inside it.
        return db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            if (attempt++ > 0)
            {
                db.ChangeTracker.Clear();
            }

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'The machines of this customer are being matched.', 1;
                """, ct);
            await decide(ct);
            await db.SaveChangesAsync(ct);
            await MatchAsync(organizationId, ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
        }, cancellationToken);
    }

    private async Task MatchAsync(Guid organizationId, CancellationToken ct)
    {
        var now = time.GetUtcNow();
        var machines = await db.Machines.Where(m => m.OrganizationId == organizationId).ToDictionaryAsync(m => m.Id, ct);
        var machineIds = machines.Keys.ToList();
        // A device that moved here from another customer still names that customer's machine: it starts here without one.
        var devices = await db.Devices.Where(d => d.OrganizationId == organizationId || (d.MachineId != null && machineIds.Contains(d.MachineId.Value)))
            .ToListAsync(ct);
        var current = devices.Where(d => d.OrganizationId == organizationId && d.RemovedAt == null).ToList();
        var ids = current.Select(d => d.Id).ToList();
        var decisions = await db.MachineLinkDecisions.AsNoTracking()
            .Where(d => d.OrganizationId == organizationId && ids.Contains(d.DeviceId) && ids.Contains(d.OtherDeviceId))
            .Select(d => new MatchDecision(d.DeviceId, d.OtherDeviceId, d.Kind)).ToListAsync(ct);

        var match = MachineMatcher.Match(
            current.Select(d => new MatchDevice(
                d.Id, d.System, d.MachineName, d.SerialNumber, d.MacAddressList, d.FirstSeenAt,
                d.MachineId is { } machine && machines.ContainsKey(machine) ? machine : null)).ToList(),
            decisions,
            () => SequentialId.New(now));

        foreach (var id in match.NewMachines)
        {
            var machine = Machine.Create(id, organizationId, now);
            machines[id] = machine;
            db.Machines.Add(machine);
        }

        foreach (var device in current)
        {
            device.BelongTo(match.MachineOfDevice[device.Id]);
        }

        // A device of another customer, or one no longer reported, keeps its machine only while it is this customer's.
        foreach (var device in devices.Where(d => d.OrganizationId != organizationId && d.MachineId is { } m && machines.ContainsKey(m)))
        {
            device.BelongTo(null);
        }

        var byMachine = devices.Where(d => d.MachineId is not null).ToLookup(d => d.MachineId!.Value);
        foreach (var machine in machines.Values)
        {
            var members = byMachine[machine.Id].ToList();
            if (members.Count == 0)
            {
                db.Machines.Remove(machine);
                continue;
            }

            machine.Refresh(members);
        }

        await StoreProposalsAsync(organizationId, match.Proposals, now, ct);
    }

    private async Task StoreProposalsAsync(Guid organizationId, IReadOnlyList<ProposedLink> found, DateTimeOffset now, CancellationToken ct)
    {
        var stored = await db.MachineProposals.Where(p => p.OrganizationId == organizationId).ToListAsync(ct);
        var wanted = found.ToDictionary(p => (p.MachineId, p.OtherMachineId));
        foreach (var proposal in stored)
        {
            if (wanted.Remove((proposal.MachineId, proposal.OtherMachineId), out var still))
            {
                proposal.Update(still.DeviceId, still.OtherDeviceId, still.Evidence);
            }
            else
            {
                db.MachineProposals.Remove(proposal);
            }
        }

        db.MachineProposals.AddRange(wanted.Values.Select(p =>
            MachineProposal.Found(organizationId, p.MachineId, p.OtherMachineId, p.DeviceId, p.OtherDeviceId, p.Evidence, now)));
    }
}
