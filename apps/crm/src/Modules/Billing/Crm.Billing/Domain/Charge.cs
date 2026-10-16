using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Billing.Domain;

/// <summary>Which source an obligation comes from (docs/adr/ADR-013).</summary>
public enum ChargeKind
{
    /// <summary>A contract service for the days it is billed for: series and interval.</summary>
    Contract,

    /// <summary>An approved time allocation billed at a rate.</summary>
    Time,

    /// <summary>An approved allocation covered by the contract or drawn from prepaid hours: shown, never priced.</summary>
    TimeInfo,

    /// <summary>The purchase movement of a prepaid hour package.</summary>
    HourBankPurchase,

    /// <summary>A one-time item waiting in <c>billing.PendingCharges</c>: accepted quote, completed project phase, correction.</summary>
    OneOff,

    /// <summary>A line billed before the register existed whose source cannot be proven; Finance decides about it.</summary>
    Legacy,
}

/// <summary>
/// Where an obligation stands. Only <see cref="Released"/> frees it for another basis; everything else holds it, so no
/// second run, collect or retry can bill it again.
/// </summary>
public enum ChargeStatus
{
    /// <summary>On a basis of a run that is not approved yet.</summary>
    Reserved,

    /// <summary>On an approved basis that has not reached the accounting system yet.</summary>
    Committed,

    /// <summary>The accounting system has the order.</summary>
    ExportConfirmed,

    /// <summary>A send may have created the order but nobody can prove it either way; a person has to check.</summary>
    ReconciliationRequired,

    /// <summary>Not billed: the line left the basis or the basis was cancelled before anything was sent.</summary>
    Released,

    /// <summary>Billed before the register existed and not provable; holds what it may cover until Finance decides.</summary>
    LegacyUnresolved,
}

/// <summary>
/// What a collected line claims: one economic obligation identified by <see cref="Key"/> — the source and, for a contract,
/// the series and the days it is billed for. A summarised line claims several (one per approved time allocation).
/// </summary>
public sealed record ChargeClaim(
    string Key,
    ChargeKind Kind,
    decimal Amount,
    Guid? SeriesId = null,
    DateOnly? ServiceFrom = null,
    DateOnly? ServiceTo = null,
    Guid? ContractLineId = null,
    Guid? CorrectsLineId = null);

/// <summary>
/// One economic obligation of a customer, across runs (docs/adr/ADR-013). A new run, a collect, a repeated import or a
/// redelivered event never makes a second one: the key is unique among the charges that are not released, and contract
/// intervals of one series never overlap. The charge follows its line through approval and export; Finance's corrections
/// of something already billed are new one-time charges that refer to the line they correct.
/// </summary>
public sealed class Charge : AuditableEntity
{
    public const string Nok = "NOK";

    private Charge() { }

    public string Key { get; private set; } = string.Empty;
    public ChargeKind Kind { get; private set; }

    /// <summary>For a contract service: the series across its versions and the days billed.</summary>
    public Guid? SeriesId { get; private set; }

    public DateOnly? ServiceFrom { get; private set; }
    public DateOnly? ServiceTo { get; private set; }

    /// <summary>The contract line version a contract charge was priced from, and what a legacy line referred to.</summary>
    public Guid? ContractLineId { get; private set; }

    /// <summary>A correction: the exported line whose amount it adds to.</summary>
    public Guid? CorrectsLineId { get; private set; }

    /// <summary>The customer the service was delivered to; the payer differs when a group parent pays (FR-CUS-07).</summary>
    public Guid SourceOrganizationId { get; private set; }

    public Guid PayerOrganizationId { get; private set; }
    public string Currency { get; private set; } = Nok;

    /// <summary>What the obligation adds to its basis, excluding VAT, as last collected.</summary>
    public decimal Amount { get; private set; }

    public ChargeStatus Status { get; private set; }

    /// <summary>The run, basis and line that carry the obligation now.</summary>
    public Guid? RunId { get; private set; }

    public Guid? BasisId { get; private set; }
    public Guid? LineId { get; private set; }
    public DateTimeOffset StatusChangedAt { get; private set; }

    /// <summary>Why the charge was released, needs reconciliation or was decided about.</summary>
    public string? Reason { get; private set; }

    public bool IsActive => Status != ChargeStatus.Released;

    public static Charge Reserve(ChargeClaim claim, Guid sourceOrganizationId, BillingBasis basis, Guid lineId, DateTimeOffset at) => new()
    {
        Key = claim.Key,
        Kind = claim.Kind,
        SeriesId = claim.SeriesId,
        ServiceFrom = claim.ServiceFrom,
        ServiceTo = claim.ServiceTo,
        ContractLineId = claim.ContractLineId,
        CorrectsLineId = claim.CorrectsLineId,
        SourceOrganizationId = sourceOrganizationId,
        PayerOrganizationId = basis.OrganizationId,
        Amount = decimal.Round(claim.Amount, 2),
        Status = ChargeStatus.Reserved,
        RunId = basis.RunId,
        BasisId = basis.Id,
        LineId = lineId,
        StatusChangedAt = at,
    };

    /// <summary>A charge the backfill could not prove (ADR-013, transition from old data).</summary>
    public static Charge Legacy(
        string key, Guid payerOrganizationId, Guid runId, Guid basisId, Guid lineId, decimal amount, DateOnly periodStart, DateOnly periodEnd,
        Guid? contractLineId, string reason, DateTimeOffset at) => new()
    {
        Key = key,
        Kind = ChargeKind.Legacy,
        ServiceFrom = periodStart,
        ServiceTo = periodEnd,
        ContractLineId = contractLineId,
        SourceOrganizationId = payerOrganizationId,
        PayerOrganizationId = payerOrganizationId,
        Amount = decimal.Round(amount, 2),
        Status = ChargeStatus.LegacyUnresolved,
        RunId = runId,
        BasisId = basisId,
        LineId = lineId,
        StatusChangedAt = at,
        Reason = reason,
    };

    /// <summary>
    /// A collect of the same run sees the obligation again: it follows its line, its current amount and payer — also onto
    /// another basis of the run when a subsidiary moved to its parent's invoice.
    /// </summary>
    public Result Refresh(ChargeClaim claim, Guid sourceOrganizationId, BillingBasis basis, Guid lineId)
    {
        if (Status != ChargeStatus.Reserved || RunId != basis.RunId)
        {
            return ChargeErrors.NotHeldBy(Key);
        }

        BasisId = basis.Id;
        LineId = lineId;
        ContractLineId = claim.ContractLineId ?? ContractLineId;
        SourceOrganizationId = sourceOrganizationId;
        PayerOrganizationId = basis.OrganizationId;
        Amount = decimal.Round(claim.Amount, 2);
        return Result.Success();
    }

    /// <summary>The basis was approved: the obligation is fixed with the approved content (ADR-012).</summary>
    public Result Commit(DateTimeOffset at)
    {
        if (Status == ChargeStatus.Committed)
        {
            return Result.Success();
        }

        if (Status != ChargeStatus.Reserved)
        {
            return ChargeErrors.InvalidTransition(Key, Status, ChargeStatus.Committed);
        }

        Move(ChargeStatus.Committed, at, null);
        return Result.Success();
    }

    /// <summary>
    /// The accounting system has the order, found by a send or by reconciliation: whatever the basis held is billed now —
    /// also a legacy line of a basis exported only now, or a charge an older version approved without committing. Idempotent.
    /// </summary>
    public Result ConfirmExport(DateTimeOffset at, string? reason = null)
    {
        if (Status == ChargeStatus.ExportConfirmed)
        {
            return Result.Success();
        }

        if (Status == ChargeStatus.Released)
        {
            return ChargeErrors.InvalidTransition(Key, Status, ChargeStatus.ExportConfirmed);
        }

        Move(ChargeStatus.ExportConfirmed, at, reason);
        return Result.Success();
    }

    /// <summary>A send whose result nobody knows: the charge is held until a person checks the accounting system.</summary>
    public Result RequireReconciliation(DateTimeOffset at, string reason)
    {
        if (Status == ChargeStatus.ReconciliationRequired)
        {
            return Result.Success();
        }

        if (Status is not (ChargeStatus.Committed or ChargeStatus.Reserved))
        {
            return ChargeErrors.InvalidTransition(Key, Status, ChargeStatus.ReconciliationRequired);
        }

        Move(ChargeStatus.ReconciliationRequired, at, reason);
        return Result.Success();
    }

    /// <summary>Reconciliation found no order: the charge is committed again and may be sent or cancelled.</summary>
    public Result ReconciledNotCreated(DateTimeOffset at, string reason)
    {
        if (Status != ChargeStatus.ReconciliationRequired)
        {
            return ChargeErrors.InvalidTransition(Key, Status, ChargeStatus.Committed);
        }

        Move(ChargeStatus.Committed, at, reason);
        return Result.Success();
    }

    /// <summary>
    /// Frees the obligation for another basis. Only something never sent can be released — also a legacy line whose basis is
    /// cancelled before it was exported: an exported charge is corrected with a new charge, and one that may have been sent
    /// is reconciled first (ADR-013).
    /// </summary>
    public Result Release(DateTimeOffset at, string reason)
    {
        if (Status == ChargeStatus.Released)
        {
            return Result.Success();
        }

        if (Status is not (ChargeStatus.Reserved or ChargeStatus.Committed or ChargeStatus.LegacyUnresolved))
        {
            return ChargeErrors.InvalidTransition(Key, Status, ChargeStatus.Released);
        }

        Move(ChargeStatus.Released, at, reason);
        return Result.Success();
    }

    /// <summary>Finance decides about a legacy charge: billed back then (it keeps holding) or not (it is released).</summary>
    public Result DecideLegacy(bool billed, string reason, DateTimeOffset at)
    {
        if (Status != ChargeStatus.LegacyUnresolved)
        {
            return ChargeErrors.InvalidTransition(Key, Status, billed ? ChargeStatus.ExportConfirmed : ChargeStatus.Released);
        }

        Move(billed ? ChargeStatus.ExportConfirmed : ChargeStatus.Released, at, reason);
        return Result.Success();
    }

    private void Move(ChargeStatus status, DateTimeOffset at, string? reason)
    {
        Status = status;
        StatusChangedAt = at;
        Reason = reason is null ? null : reason.Length > 512 ? reason[..512] : reason;
    }
}

/// <summary>The parts of an interval that no other charge of the same contract series covers yet (ADR-013).</summary>
public static class ChargeCoverage
{
    /// <summary>
    /// <paramref name="from"/>–<paramref name="to"/> minus every taken interval, as the remaining pieces in date order. A
    /// quarter invoiced in advance and a month of the same series invoiced later never overlap this way, whatever their
    /// boundaries.
    /// </summary>
    public static IReadOnlyList<(DateOnly From, DateOnly To)> Uncovered(DateOnly from, DateOnly to, IEnumerable<(DateOnly From, DateOnly To)> taken)
    {
        var pieces = new List<(DateOnly From, DateOnly To)> { (from, to) };
        foreach (var (takenFrom, takenTo) in taken.OrderBy(t => t.From))
        {
            var next = new List<(DateOnly From, DateOnly To)>();
            foreach (var piece in pieces)
            {
                if (takenTo < piece.From || takenFrom > piece.To)
                {
                    next.Add(piece);
                    continue;
                }

                if (takenFrom > piece.From)
                {
                    next.Add((piece.From, takenFrom.AddDays(-1)));
                }

                if (takenTo < piece.To)
                {
                    next.Add((takenTo.AddDays(1), piece.To));
                }
            }

            pieces = next;
        }

        return pieces;
    }
}

internal static class ChargeErrors
{
    public static Error NotHeldBy(string key) => Error.Conflict("BIL_CHARGE_HELD_ELSEWHERE", $"The charge {key} is held by another basis.");

    public static Error InvalidTransition(string key, ChargeStatus from, ChargeStatus to) => Error.Conflict(
        "BIL_CHARGE_INVALID_STATUS", $"The charge {key} cannot go from {from} to {to}.",
        new Dictionary<string, object?> { ["from"] = from.ToString(), ["to"] = to.ToString() });
}
