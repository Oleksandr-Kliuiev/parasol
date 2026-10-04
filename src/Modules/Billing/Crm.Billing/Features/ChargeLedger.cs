using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

/// <summary>
/// The charge register (docs/adr/ADR-013): which economic obligations a basis bills, across runs. A collect takes the
/// register's lock for its transaction, reads what other runs hold and leaves those obligations out; afterwards every basis
/// holds exactly the obligations its billed lines claim.
/// </summary>
internal sealed class ChargeLedger(BillingDbContext db)
{
    /// <summary>
    /// Serialises everything that reserves charges. The key of an obligation is unique among active charges in the database;
    /// the lock also makes the check that two intervals of a contract series do not overlap safe, which an index cannot express.
    /// </summary>
    public async Task LockAsync(CancellationToken ct) =>
        await db.Database.ExecuteSqlRawAsync(
            """
            DECLARE @result int;
            EXEC @result = sp_getapplock @Resource = N'billing:charges', @LockMode = N'Exclusive', @LockOwner = N'Transaction', @LockTimeout = 60000;
            IF @result < 0 THROW 51000, N'BILLING_CHARGES_BUSY', 1;
            """,
            ct);

    public async Task<ChargeSnapshot> LoadAsync(
        Guid runId, IReadOnlyCollection<string> keys, IReadOnlyCollection<Guid> seriesIds, IReadOnlyCollection<Guid> contractLineIds, CancellationToken ct)
    {
        var charges = await db.Charges
            .Where(c => c.Status != ChargeStatus.Released &&
                        (c.RunId == runId ||
                         keys.Contains(c.Key) ||
                         (c.SeriesId != null && seriesIds.Contains(c.SeriesId.Value)) ||
                         (c.Kind == ChargeKind.Legacy && c.ContractLineId != null && contractLineIds.Contains(c.ContractLineId.Value))))
            .ToListAsync(ct);
        var runIds = charges.Where(c => c.RunId is not null).Select(c => c.RunId!.Value).Distinct().ToList();
        var periods = await db.BillingRuns.IgnoreQueryFilters()
            .Where(r => runIds.Contains(r.Id))
            .ToDictionaryAsync(r => r.Id, r => r.PeriodStart, ct);
        return new ChargeSnapshot(runId, charges, periods);
    }

    /// <summary>
    /// Makes a basis hold the obligations of its billed collected lines: new ones are reserved, those still billed follow
    /// their line, and those no longer billed (line excluded or gone, basis cancelled or emptied) are released. A line Finance
    /// keeps although its source has gone keeps what it held.
    /// </summary>
    public void Sync(BillingBasis basis, IReadOnlyCollection<LineDraft> drafts, ChargeSnapshot snapshot, DateTimeOffset at)
    {
        var desired = new Dictionary<string, (ChargeClaim Claim, Guid LineId, Guid SourceOrganizationId)>(StringComparer.Ordinal);
        if (!basis.IsDeleted && basis.Status != BillingBasisStatus.Cancelled)
        {
            var draftsByKey = drafts.Where(d => d.SourceKey is not null).ToDictionary(d => d.SourceKey!, StringComparer.Ordinal);
            foreach (var line in basis.BilledLines.Where(l => l.Origin == BillingLineOrigin.Collected && l.SourceKey is not null))
            {
                if (draftsByKey.TryGetValue(line.SourceKey!, out var draft))
                {
                    foreach (var claim in draft.Claims ?? [])
                    {
                        desired[claim.Key] = (claim, line.Id, draft.SourceOrganizationId ?? basis.OrganizationId);
                    }

                    continue;
                }

                foreach (var held in snapshot.HeldBy(basis.Id).Where(c => c.LineId == line.Id))
                {
                    desired[held.Key] = (ClaimOf(held), line.Id, held.SourceOrganizationId);
                }
            }
        }

        foreach (var held in snapshot.HeldBy(basis.Id).Where(c => !desired.ContainsKey(c.Key)).ToList())
        {
            Ensure(held.Release(at, basis.IsDeleted || basis.Status == BillingBasisStatus.Cancelled
                ? "The basis no longer bills anything."
                : "The line no longer bills the obligation."));
        }

        foreach (var (key, (claim, lineId, sourceOrganizationId)) in desired)
        {
            if (snapshot.Active(key) is not { } active)
            {
                var reserved = Charge.Reserve(claim, sourceOrganizationId, basis, lineId, at);
                db.Charges.Add(reserved);
                snapshot.Add(reserved);
                continue;
            }

            // The collector left out what other runs hold; meeting one here means a source broke that rule.
            Ensure(active.Refresh(claim, sourceOrganizationId, basis, lineId));
        }
    }

    /// <summary>Releases every obligation a basis holds, e.g. when it is cancelled before anything was sent.</summary>
    public async Task ReleaseAsync(Guid basisId, string reason, DateTimeOffset at, CancellationToken ct)
    {
        foreach (var charge in await db.Charges.Where(c => c.BasisId == basisId && c.Status != ChargeStatus.Released).ToListAsync(ct))
        {
            Ensure(charge.Release(at, reason));
        }
    }

    /// <summary>The run was approved: what its approved bases hold is committed; an information-only basis bills nothing.</summary>
    public async Task CommitAsync(Guid runId, IReadOnlyCollection<BillingBasis> bases, DateTimeOffset at, CancellationToken ct)
    {
        var statuses = bases.ToDictionary(b => b.Id, b => b.Status);
        foreach (var charge in await db.Charges.Where(c => c.RunId == runId && c.Status == ChargeStatus.Reserved).ToListAsync(ct))
        {
            if (charge.BasisId is { } basisId && statuses.TryGetValue(basisId, out var status) && status == BillingBasisStatus.Approved)
            {
                Ensure(charge.Commit(at));
            }
            else
            {
                Ensure(charge.Release(at, "Nothing to invoice on the basis."));
            }
        }
    }

    public async Task ConfirmExportAsync(Guid basisId, DateTimeOffset at, string? reason, CancellationToken ct)
    {
        foreach (var charge in await db.Charges.Where(c => c.BasisId == basisId && c.Status != ChargeStatus.Released).ToListAsync(ct))
        {
            Ensure(charge.ConfirmExport(at, reason));
        }
    }

    public async Task RequireReconciliationAsync(Guid basisId, DateTimeOffset at, string reason, CancellationToken ct)
    {
        foreach (var charge in await db.Charges.Where(c => c.BasisId == basisId && (c.Status == ChargeStatus.Committed || c.Status == ChargeStatus.Reserved)).ToListAsync(ct))
        {
            Ensure(charge.RequireReconciliation(at, reason));
        }
    }

    public async Task ReconciledNotCreatedAsync(Guid basisId, DateTimeOffset at, string reason, CancellationToken ct)
    {
        foreach (var charge in await db.Charges.Where(c => c.BasisId == basisId && c.Status == ChargeStatus.ReconciliationRequired).ToListAsync(ct))
        {
            Ensure(charge.ReconciledNotCreated(at, reason));
        }
    }

    public static string ContractKey(Guid seriesId, DateOnly from, DateOnly to) =>
        string.Create(CultureInfo.InvariantCulture, $"contract:{seriesId:N}:{from:yyyy-MM-dd}:{to:yyyy-MM-dd}");

    public static string TimeKey(Guid allocationId) => string.Create(CultureInfo.InvariantCulture, $"time:{allocationId:N}");

    public static string HourBankKey(Guid entryId) => string.Create(CultureInfo.InvariantCulture, $"hourbank:{entryId:N}");

    public static string PendingKey(Guid pendingChargeId) => string.Create(CultureInfo.InvariantCulture, $"pending:{pendingChargeId:N}");

    private static ChargeClaim ClaimOf(Charge charge) =>
        new(charge.Key, charge.Kind, charge.Amount, charge.SeriesId, charge.ServiceFrom, charge.ServiceTo, charge.ContractLineId, charge.CorrectsLineId);

    private static void Ensure(SharedKernel.Results.Result result)
    {
        if (!result.IsSuccess)
        {
            throw new InvalidOperationException(result.Error!.Message);
        }
    }
}

/// <summary>The active charges a collect has to respect, read under the register's lock.</summary>
internal sealed class ChargeSnapshot(Guid runId, List<Charge> charges, IReadOnlyDictionary<Guid, DateOnly> periods)
{
    private readonly Dictionary<string, Charge> _byKey = charges.ToDictionary(c => c.Key, StringComparer.Ordinal);

    private IEnumerable<Charge> Active() => _byKey.Values.Where(c => c.IsActive);

    public Charge? Active(string key) => _byKey.TryGetValue(key, out var charge) && charge.IsActive ? charge : null;

    /// <summary>Held by a basis of another run: this run leaves the obligation out.</summary>
    public Charge? HeldElsewhere(string key) => Active(key) is { } charge && charge.RunId != runId ? charge : null;

    /// <summary>Days of a contract series another run already holds.</summary>
    public IEnumerable<(DateOnly From, DateOnly To)> TakenIntervals(Guid seriesId) =>
        Active()
            .Where(c => c.Kind == ChargeKind.Contract && c.SeriesId == seriesId && c.RunId != runId && c.ServiceFrom is not null && c.ServiceTo is not null)
            .Select(c => (c.ServiceFrom!.Value, c.ServiceTo!.Value));

    /// <summary>An unresolved legacy charge of the contract line version, billed by another run for days this one would bill.</summary>
    public Charge? LegacyFor(Guid contractLineId, DateOnly from, DateOnly to) =>
        Active().FirstOrDefault(c => c.Kind == ChargeKind.Legacy && c.Status == ChargeStatus.LegacyUnresolved && c.ContractLineId == contractLineId &&
                                     c.RunId != runId && c.ServiceFrom <= to && c.ServiceTo >= from);

    public IEnumerable<Charge> HeldBy(Guid basisId) => Active().Where(c => c.BasisId == basisId);

    public DateOnly? PeriodOf(Charge charge) => charge.RunId is { } id && periods.TryGetValue(id, out var period) ? period : null;

    public void Add(Charge charge) => _byKey[charge.Key] = charge;
}
