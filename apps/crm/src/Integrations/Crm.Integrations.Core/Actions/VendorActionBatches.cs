using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

/// <summary>Many targets of one kind, asked for together (M45), with the parameters every one of them takes.</summary>
public sealed record VendorActionBatchRequest(string System, string Kind, string TargetType, IReadOnlyList<string> TargetIds, JsonElement Parameters);

/// <summary>
/// A handler whose kind may be asked for many targets at once (M45): it plans a whole batch from saved data in a few reads, never one
/// read per target, and answers with a plan for each target asked (<see cref="VendorActionPlan.NotFound"/> for one it does not
/// know). Only a kind whose handler implements this, and never a destructive one, is offered for a batch.
/// </summary>
public interface IVendorActionBatchPlanner
{
    Task<IReadOnlyDictionary<string, VendorActionPlan>> PlanManyAsync(VendorActionBatchRequest request, CancellationToken cancellationToken);
}

public sealed record VendorActionBatchPreviewRequest(string? System, string? Kind, string? TargetType, IReadOnlyList<string>? TargetIds, JsonElement Parameters);

/// <summary>
/// The confirmation of a batch: the preview's token, the targets it showed as ready (exactly those) and a key of this confirmation,
/// so a repeat after a lost answer returns the actions already saved instead of asking again.
/// </summary>
public sealed record VendorActionBatchCommand(
    string? PreviewToken, string? System, string? Kind, string? TargetType, IReadOnlyList<string>? TargetIds, JsonElement Parameters, Guid BatchKey,
    string? Reason);

/// <summary>
/// One target of a batch preview: the CRM's saved copy of it (null when there is none) and what keeps it out of the batch, if anything.
/// <paramref name="WaitingActionId"/> names the action of the same kind someone already asked for it that has not been sent yet.
/// </summary>
public sealed record VendorActionBatchTarget(string TargetId, VendorActionTarget? Target, VendorActionBlock? Block, Guid? WaitingActionId = null);

/// <summary>
/// The preview of a batch (M45), from saved data only. <paramref name="Ready"/> targets will each get an action; without a
/// <paramref name="Block"/> of the whole batch and with at least one ready target it carries the token the command brings back.
/// </summary>
public sealed record VendorActionBatchPreview(
    string? PreviewToken,
    DateTimeOffset? ExpiresAt,
    string System,
    string Kind,
    VendorActionLevel Level,
    IReadOnlyList<VendorActionBatchTarget> Targets,
    int Ready,
    VendorActionBlock? Block,
    VendorActionConfirmation Confirmation,
    bool Simulated,
    bool Paused);

/// <summary>
/// What the command did with one target: the action asked for it (new, saved by an earlier answer of the same confirmation, or one of
/// the same kind already waiting) or the code of what kept it out.
/// </summary>
public sealed record VendorActionBatchItem(string TargetId, Guid? ActionId, VendorActionStatus? Status, string? Code);

/// <summary>The batch the command saved; <paramref name="Asked"/> counts its new actions, <paramref name="Repeated"/> says it was saved before.</summary>
public sealed record VendorActionBatchResult(Guid? BatchId, IReadOnlyList<VendorActionBatchItem> Items, int Asked, bool Repeated);

/// <summary>One action of a batch as it stands now.</summary>
public sealed record VendorActionBatchEntry(
    Guid ActionId, string TargetId, string TargetName, Guid? OrganizationId, string? OrganizationName, VendorActionStatus Status, string? OutcomeCode,
    DateTimeOffset? CompletedAt);

/// <summary>
/// A batch as it stands now (M45): its actions in all, those that wait, and those that came to each outcome — done, already so, only
/// simulated (DryRun), refused or failed (with the cancelled ones), and without a clear answer; with the actions themselves when asked.
/// </summary>
public sealed record VendorActionBatchState(
    Guid Id, string System, string Kind, int Total, int Waiting, int Succeeded, int Skipped, int Simulated, int Failed, int Uncertain,
    IReadOnlyList<VendorActionBatchEntry> Items);

/// <summary>What a batch preview token vouches for: this person saw exactly these ready targets of this kind with these parameters.</summary>
public sealed record VendorActionBatchClaim(
    Guid UserId, string System, string Kind, string TargetType, VendorActionLevel Level, string Parameters, string Targets, DateTimeOffset ExpiresAt);

/// <summary>The signed token of a batch preview (M45), like <see cref="VendorActionPreviewToken"/> for one action, with a purpose of its own.</summary>
public static class VendorActionBatchToken
{
    public const string Purpose = "Crm.VendorActions.BatchPreview.v1";

    public static string Issue(IDataProtectionProvider protection, VendorActionBatchClaim claim) =>
        protection.CreateProtector(Purpose).Protect(JsonSerializer.Serialize(claim));

    public static VendorActionBatchClaim? Read(IDataProtectionProvider protection, string? token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<VendorActionBatchClaim>(protection.CreateProtector(Purpose).Unprotect(token));
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or FormatException)
        {
            return null;
        }
    }
}

/// <summary>The rules of a batch (M45), as pure functions: which kinds take one, how its targets and keys are fixed.</summary>
public static class VendorActionBatches
{
    /// <summary>The most targets one batch takes: a page of "all that match" of the alert queue.</summary>
    public const int MaxTargets = 500;

    /// <summary>A kind is asked for in bulk only when its handler plans a batch, and never when it destroys something.</summary>
    public static bool Supports(IVendorActionHandler handler) => handler is IVendorActionBatchPlanner && handler.Level != VendorActionLevel.Destructive;

    /// <summary>Each target once, in the order asked.</summary>
    public static IReadOnlyList<string> Distinct(IEnumerable<string> targetIds) => targetIds.Distinct(StringComparer.Ordinal).ToList();

    /// <summary>What a token fixes about the targets: the set of ids, in no particular order.</summary>
    public static string Targets(IEnumerable<string> targetIds) => Hash(string.Join('\n', targetIds.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)));

    /// <summary>
    /// The command key of one target of a batch, made from the confirmation's key and the set of its targets: a repeat of the
    /// confirmation finds the action it saved for each target through the unique (person, command key) of every action, exactly as a
    /// repeat of one action does, while the same key sent with other targets is another confirmation and finds none.
    /// </summary>
    public static Guid CommandKey(Guid batchKey, string targets, string system, string kind, string targetType, string targetId) =>
        new(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', "batch", batchKey.ToString("D"), targets, system, kind, targetType, targetId)))[..16]);

    public static string Hash(string value) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

/// <summary>
/// One confirmation for many targets of one kind (M45), on the M39.1 path: the preview plans every target from saved data and signs
/// the set that is ready; the command plans them again and saves one <see cref="VendorAction"/> with its outbound operation per
/// target, in one transaction, as one action asked alone would be saved. The worker sends them one by one and one per target at a
/// time; the log on /connections shows each. A target whose saved copy changed since the preview is left out with the code that
/// says why, and so is one with an action of the same kind still waiting, so a batch never asks the same thing twice.
/// </summary>
public sealed class VendorActionBatchService(
    IntegrationDbContext db,
    IEnumerable<IVendorActionGate> gates,
    VendorActionService actions,
    VendorActionReader reader,
    ICurrentUser user,
    TimeProvider time)
{
    private static readonly VendorActionStatus[] Waiting = [VendorActionStatus.Scheduled, VendorActionStatus.Queued, VendorActionStatus.Sending];

    public async Task<Result<VendorActionBatchPreview>> PreviewAsync(
        VendorActionBatchPreviewRequest body, IDataProtectionProvider protection, CancellationToken ct)
    {
        var found = Find(body.System, body.Kind, body.TargetType);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var (handler, planner, userId) = found.Value;
        var ids = VendorActionBatches.Distinct(body.TargetIds!);
        var switches = Switches(handler.System);
        var block = Whole(switches, handler.Kind);
        var targets = await PlanAsync(handler, planner, ids, body.Parameters, switches, ct);
        var ready = targets.Where(t => t.Block is null).ToList();
        var parameters = ready.Select(t => t.Parameters).Distinct(StringComparer.Ordinal).ToList();
        // One confirmation shows one action: targets that would read the parameters differently are asked for one at a time.
        block ??= parameters.Count > 1 ? new VendorActionBlock("VND_BATCH_PARAMETERS", "The targets take the parameters differently; ask for them one at a time.") : null;
        string? token = null;
        DateTimeOffset? expires = null;
        if (block is null && ready.Count > 0)
        {
            expires = time.GetUtcNow() + VendorActionPreviewToken.Lifetime;
            token = VendorActionBatchToken.Issue(protection, new VendorActionBatchClaim(userId, handler.System, handler.Kind, handler.TargetType, handler.Level,
                VendorActionBatches.Hash(parameters[0]), VendorActionBatches.Targets(ready.Select(t => t.TargetId)), expires.Value));
        }

        var paused = await db.IntegrationSwitches.AsNoTracking().AnyAsync(s => s.System == handler.System && s.IsPaused, ct);
        return new VendorActionBatchPreview(token, expires, handler.System, handler.Kind, handler.Level,
            targets.Select(t => new VendorActionBatchTarget(t.TargetId, t.Target, t.Block, t.WaitingId)).ToList(), ready.Count, block,
            VendorActionConfirmation.For(handler.Level), switches?.DryRun == true, paused);
    }

    /// <summary>
    /// Saves one action per ready target, or answers with the actions an earlier answer of the same confirmation saved (Repeated): a
    /// repeat never asks anything new.
    /// </summary>
    public async Task<Result<VendorActionBatchResult>> RequestAsync(VendorActionBatchCommand body, IDataProtectionProvider protection, CancellationToken ct)
    {
        var found = Find(body.System, body.Kind, body.TargetType);
        if (!found.IsSuccess)
        {
            return found.Error!;
        }

        var (handler, planner, userId) = found.Value;
        var ids = VendorActionBatches.Distinct(body.TargetIds!);
        var set = VendorActionBatches.Targets(ids);
        var keys = ids.ToDictionary(id => id, id => VendorActionBatches.CommandKey(body.BatchKey, set, handler.System, handler.Kind, handler.TargetType, id),
            StringComparer.Ordinal);
        var claim = VendorActionBatchToken.Read(protection, body.PreviewToken);
        var sameTargets = claim is not null && claim.UserId == userId && claim.System == handler.System && claim.Kind == handler.Kind &&
                          claim.TargetType == handler.TargetType && claim.Targets == set;
        // A repeat after a lost answer: answered with what was saved, whether or not its preview has aged since.
        if (await EarlierAsync(userId, keys, ct) is { Count: > 0 } earlier)
        {
            return sameTargets
                ? Repeat(ids, keys, earlier)
                : Error.Conflict("VND_COMMAND_KEY_REUSED", "This confirmation was used with another preview.");
        }

        if (claim is null || claim.UserId != userId || claim.ExpiresAt < time.GetUtcNow() || claim.Level != handler.Level)
        {
            return Error.Conflict("VND_PREVIEW_EXPIRED", "The preview is older than ten minutes or belongs to someone else; show it again.");
        }

        if (!sameTargets)
        {
            return Error.Conflict("VND_PREVIEW_STALE", "These are not the targets the preview showed; show the preview again.");
        }

        if (handler.Level != VendorActionLevel.Standard && VendorActionRules.CheckConfirmation(handler.Level, body.Reason, null, string.Empty) is { } unconfirmed)
        {
            return Error.Validation(unconfirmed.Code, unconfirmed.Message);
        }

        var switches = Switches(handler.System);
        if (Whole(switches, handler.Kind) is { } off)
        {
            return Error.Conflict(off.Code, off.Message);
        }

        // Planned and saved under a lock of the kind: of two confirmations at the same moment the later plans once the earlier is saved,
        // so it sees the earlier's actions waiting and asks nothing twice, and a repeat of the same confirmation finds what was saved.
        var resource = $"vendor-actions:{handler.System}:{handler.Kind}";
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async c =>
        {
            db.ChangeTracker.Clear();
            await using var transaction = await db.Database.BeginTransactionAsync(c);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={resource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another confirmation of these actions is being saved.', 1;
                """, c);
            if (await EarlierAsync(userId, keys, c) is { Count: > 0 } first)
            {
                return Repeat(ids, keys, first);
            }

            var batchId = SequentialId.New(time.GetUtcNow());
            var items = new List<VendorActionBatchItem>(ids.Count);
            var asked = 0;
            foreach (var target in await PlanAsync(handler, planner, ids, body.Parameters, switches, c))
            {
                if (target.Block is { } blocked)
                {
                    items.Add(new VendorActionBatchItem(target.TargetId, target.WaitingId, target.WaitingStatus, blocked.Code));
                }
                else if (VendorActionBatches.Hash(target.Parameters) != claim.Parameters)
                {
                    items.Add(new VendorActionBatchItem(target.TargetId, null, null, "VND_PREVIEW_STALE"));
                }
                else
                {
                    var fingerprint = VendorActionRules.Fingerprint(handler.System, handler.Kind, handler.TargetType, target.Target!.Id, target.Parameters);
                    var action = actions.Enqueue(handler, target.Target, target.Parameters, fingerprint, body.Reason, userId, keys[target.TargetId], batchId);
                    items.Add(new VendorActionBatchItem(target.TargetId, action.Id, action.Status, null));
                    asked++;
                }
            }

            try
            {
                await db.SaveChangesAsync(c);
            }
            catch (DbUpdateException ex) when (ex.InnerException is Microsoft.Data.SqlClient.SqlException { Number: 2601 or 2627 })
            {
                // A command key of this confirmation was saved meanwhile by a request the lock does not hold back: answer with it.
                await transaction.RollbackAsync(c);
                db.ChangeTracker.Clear();
                return Repeat(ids, keys, await EarlierAsync(userId, keys, c));
            }

            await transaction.CommitAsync(c);
            return new VendorActionBatchResult(asked > 0 ? batchId : null, items, asked, false);
        }, ct);
    }

    /// <summary>A batch as it stands now; <paramref name="withItems"/> adds every action of it.</summary>
    public Task<Result<VendorActionBatchState>> ReadAsync(Guid batchId, bool withItems, CancellationToken ct) => reader.BatchAsync(batchId, withItems, ct);

    private sealed record Planned(
        string TargetId, VendorActionTarget? Target, VendorActionBlock? Block, string Parameters, Guid? WaitingId = null, VendorActionStatus? WaitingStatus = null);

    /// <summary>
    /// Every target planned from saved data, then checked as the command will check it: a target the CRM does not know, one its handler
    /// blocks, one whose customer the vendor's allow-list leaves out, and one with an action of the same kind still waiting stay out.
    /// </summary>
    private async Task<IReadOnlyList<Planned>> PlanAsync(
        IVendorActionHandler handler, IVendorActionBatchPlanner planner, IReadOnlyList<string> ids, JsonElement parameters, VendorActionSwitches? switches,
        CancellationToken ct)
    {
        var plans = await planner.PlanManyAsync(new VendorActionBatchRequest(handler.System, handler.Kind, handler.TargetType, ids, parameters), ct);
        var waiting = (await db.VendorActions.AsNoTracking()
                .Where(a => a.System == handler.System && a.Kind == handler.Kind && a.TargetType == handler.TargetType && ids.Contains(a.TargetId) &&
                            Waiting.Contains(a.Status))
                .Select(a => new { a.TargetId, a.Id, a.Status }).ToListAsync(ct))
            .GroupBy(a => a.TargetId, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        return ids.Select(id =>
        {
            var plan = plans.GetValueOrDefault(id) ?? VendorActionPlan.NotFound;
            if (plan.Target is not { } target)
            {
                return new Planned(id, null, new VendorActionBlock("VND_TARGET_NOT_FOUND", "The CRM has no saved copy of this target."), plan.CanonicalParameters);
            }

            if (plan.Block is { } blocked)
            {
                return new Planned(id, target, blocked, plan.CanonicalParameters);
            }

            if (waiting.TryGetValue(target.Id, out var earlier))
            {
                return new Planned(id, target, new VendorActionBlock("VND_ALREADY_WAITING", "The same was asked for this target and has not been sent yet."),
                    plan.CanonicalParameters, earlier.Id, earlier.Status);
            }

            var customer = VendorActionRules.CheckSwitches(switches, handler.Kind, target.ExternalCustomerId, credentials: false, target.OrganizationId);
            return new Planned(id, target, customer, plan.CanonicalParameters);
        }).ToList();
    }

    /// <summary>What the vendor's switches say about the kind for every target alike; the allow-list is a matter of each target.</summary>
    private static VendorActionBlock? Whole(VendorActionSwitches? switches, string kind) =>
        VendorActionRules.CheckSwitches(switches is null ? null : switches with { AllowedCustomerIds = [] }, kind, null, credentials: false);

    private Result<(IVendorActionHandler Handler, IVendorActionBatchPlanner Planner, Guid UserId)> Find(string? system, string? kind, string? targetType)
    {
        if (actions.Find(system, kind, targetType) is not { } handler)
        {
            return Error.Validation("VND_UNKNOWN_KIND", "There is no such action for this vendor and target.");
        }

        if (!VendorActionBatches.Supports(handler) || handler is not IVendorActionBatchPlanner planner)
        {
            return Error.Validation("VND_BATCH_UNSUPPORTED", "This kind of action is asked for one target at a time.");
        }

        return user.HasPermission(handler.Permission) && user.UserId is { } userId
            ? (handler, planner, userId)
            : Error.Forbidden("VND_FORBIDDEN", "Your access does not include this action.");
    }

    private async Task<List<VendorAction>> EarlierAsync(Guid userId, Dictionary<string, Guid> keys, CancellationToken ct)
    {
        var commandKeys = keys.Values.ToList();
        return await db.VendorActions.AsNoTracking().Where(a => a.RequestedBy == userId && commandKeys.Contains(a.CommandKey)).ToListAsync(ct);
    }

    /// <summary>The answer to a repeat: the actions saved for the confirmation, and nothing asked for the other targets.</summary>
    private static VendorActionBatchResult Repeat(IReadOnlyList<string> ids, Dictionary<string, Guid> keys, List<VendorAction> earlier)
    {
        var byKey = earlier.ToDictionary(a => a.CommandKey);
        var items = ids.Select(id => byKey.TryGetValue(keys[id], out var action)
            ? new VendorActionBatchItem(id, action.Id, action.Status, null)
            : new VendorActionBatchItem(id, null, null, "VND_NOT_ASKED")).ToList();
        return new VendorActionBatchResult(earlier.Select(a => a.BatchId).FirstOrDefault(b => b is not null), items, 0, true);
    }

    private VendorActionSwitches? Switches(string system) => gates.SingleOrDefault(g => g.System == system)?.Read();
}
