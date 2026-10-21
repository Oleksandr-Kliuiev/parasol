using System.Text.Json;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

public sealed record VendorActionPreviewRequest(string? System, string? Kind, string? TargetType, string? TargetId, JsonElement Parameters);

/// <summary>What confirming takes at the action's level: a reason, the target's name typed, a fresh sign-in, a hold in seconds.</summary>
public sealed record VendorActionConfirmation(bool Reason, bool TypedName, bool FreshSignIn, int HoldSeconds)
{
    public static VendorActionConfirmation For(VendorActionLevel level) => level switch
    {
        VendorActionLevel.Destructive => new(true, true, true, (int)VendorActionRules.DestructiveHold.TotalSeconds),
        VendorActionLevel.Disruptive => new(true, false, false, 0),
        _ => new(false, false, false, 0),
    };
}

/// <summary>
/// A preview (M39.1). Without a <paramref name="Block"/> it carries a <paramref name="PreviewToken"/> that the command must bring
/// back. <paramref name="Simulated"/>: the vendor is in DryRun, nothing will be sent. <paramref name="Paused"/>: the integration
/// is paused, so the action waits until it is resumed.
/// </summary>
public sealed record VendorActionPreview(
    string? PreviewToken,
    DateTimeOffset? ExpiresAt,
    string System,
    string Kind,
    VendorActionLevel Level,
    VendorActionTarget Target,
    IReadOnlyList<VendorActionEffect> Effects,
    VendorActionBlock? Block,
    VendorActionConfirmation Confirmation,
    bool Simulated,
    bool Paused);

/// <summary>
/// A kind the caller may ask for now (M39.3): its handler is registered, the caller holds its permission and the vendor's switches let
/// it through. <paramref name="Simulated"/>: the vendor is in DryRun. <paramref name="LimitedToCustomers"/>: an allow-list may still
/// refuse the customer, which the preview says.
/// </summary>
public sealed record VendorActionKindItem(string System, string Kind, string TargetType, VendorActionLevel Level, bool Simulated, bool LimitedToCustomers);

public sealed record VendorActionCommand(
    string? PreviewToken, string? System, string? Kind, string? TargetType, string? TargetId, JsonElement Parameters, Guid CommandKey,
    string? Reason, string? TypedName);

/// <summary>A person's verdict on an uncertain action after checking at the vendor: <c>Succeeded</c> (it is there) or <c>Failed</c>.</summary>
public sealed record VendorActionSettlement(string? Outcome, string? Reason);

/// <summary>
/// Preview, command, cancel and settle (M39.1), in crm-web. A command saves the action and the outbound operation that carries it in
/// one transaction and returns at once; crm-worker sends it. Every change leaves an audit entry with ids, never the parameters.
/// </summary>
public sealed class VendorActionService(
    IntegrationDbContext db,
    IEnumerable<IVendorActionHandler> handlers,
    IEnumerable<IVendorActionGate> gates,
    VendorActionReader reader,
    ICurrentUser user,
    IRequestContext request,
    TimeProvider time)
{
    private static readonly Error UnknownKind = Error.Validation("VND_UNKNOWN_KIND", "There is no such action for this vendor and target.");
    private static readonly Error TargetMissing = Error.NotFound("VND_TARGET_NOT_FOUND", "The CRM has no saved copy of this target.");
    private static readonly Error NotAllowed = Error.Forbidden("VND_FORBIDDEN", "Your access does not include this action.");

    public IVendorActionHandler? Find(string? system, string? kind, string? targetType) =>
        handlers.SingleOrDefault(h => h.System == system && h.Kind == kind && h.TargetType == targetType);

    /// <summary>
    /// The kinds the caller may ask for now, so a form offers a vendor action only where a preview would let it through. The customer
    /// allow-list depends on the target, so it is left to the preview.
    /// </summary>
    public IReadOnlyList<VendorActionKindItem> Available(string? system) =>
    [
        .. handlers
            .Where(h => (system is null || h.System == system) && user.HasPermission(h.Permission))
            .Select(h => (Handler: h, Switches: Switches(h.System)))
            .Where(x => x.Switches is { } s && VendorActionRules.CheckSwitches(s with { AllowedCustomerIds = [] }, x.Handler.Kind, null, credentials: false) is null)
            .OrderBy(x => x.Handler.System, StringComparer.Ordinal).ThenBy(x => x.Handler.Kind, StringComparer.Ordinal)
            .Select(x => new VendorActionKindItem(
                x.Handler.System, x.Handler.Kind, x.Handler.TargetType, x.Handler.Level, x.Switches!.DryRun, x.Switches.AllowedCustomerIds.Count > 0)),
    ];

    public async Task<Result<VendorActionPreview>> PreviewAsync(VendorActionPreviewRequest body, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (Find(body.System, body.Kind, body.TargetType) is not { } handler)
        {
            return UnknownKind;
        }

        if (!user.HasPermission(handler.Permission) || user.UserId is not { } userId)
        {
            return NotAllowed;
        }

        var plan = await handler.PlanAsync(new VendorActionRequest(handler.System, handler.Kind, handler.TargetType, body.TargetId!, body.Parameters), ct);
        if (plan.Target is not { } target)
        {
            return TargetMissing;
        }

        var switches = Switches(handler.System);
        var block = plan.Block ?? VendorActionRules.CheckSwitches(switches, handler.Kind, target.ExternalCustomerId, credentials: false);
        var paused = await db.IntegrationSwitches.AsNoTracking().AnyAsync(s => s.System == handler.System && s.IsPaused, ct);
        string? token = null;
        DateTimeOffset? expires = null;
        if (block is null)
        {
            expires = time.GetUtcNow() + VendorActionPreviewToken.Lifetime;
            token = VendorActionPreviewToken.Issue(protection, new VendorActionPreviewClaim(
                userId, Fingerprint(handler, target, plan.CanonicalParameters), handler.Level, expires.Value));
        }

        return new VendorActionPreview(token, expires, handler.System, handler.Kind, handler.Level, target, plan.Effects, block,
            VendorActionConfirmation.For(handler.Level), switches?.DryRun == true, paused);
    }

    /// <summary>
    /// Saves the action and its outbound operation, or returns the action saved earlier under the same command key (Created false).
    /// <paramref name="destructiveEndpoint"/> says whether the call came through the endpoint that demands a fresh sign-in.
    /// </summary>
    public async Task<Result<(VendorActionItem Action, bool Created)>> RequestAsync(
        VendorActionCommand body, bool destructiveEndpoint, IDataProtectionProvider protection, CancellationToken ct)
    {
        if (Find(body.System, body.Kind, body.TargetType) is not { } handler)
        {
            return UnknownKind;
        }

        if (!user.HasPermission(handler.Permission) || user.UserId is not { } userId)
        {
            return NotAllowed;
        }

        if ((handler.Level == VendorActionLevel.Destructive) != destructiveEndpoint)
        {
            return Error.Validation("VND_WRONG_ENDPOINT", destructiveEndpoint
                ? "Only a destructive action is confirmed here."
                : "A destructive action is confirmed at /api/v1/actions/destructive, with a fresh sign-in.");
        }

        var claim = VendorActionPreviewToken.Read(protection, body.PreviewToken);
        if (await db.VendorActions.AsNoTracking().SingleOrDefaultAsync(a => a.RequestedBy == userId && a.CommandKey == body.CommandKey, ct) is { } earlier)
        {
            return await RepeatAsync(earlier, claim, ct);
        }

        if (claim is null || claim.UserId != userId || claim.ExpiresAt < time.GetUtcNow())
        {
            return Error.Conflict("VND_PREVIEW_EXPIRED", "The preview is older than ten minutes or belongs to someone else; show it again.");
        }

        var plan = await handler.PlanAsync(new VendorActionRequest(handler.System, handler.Kind, handler.TargetType, body.TargetId!, body.Parameters), ct);
        if (plan.Target is not { } target)
        {
            return TargetMissing;
        }

        if (plan.Block is { } blocked)
        {
            return Error.Conflict(blocked.Code, blocked.Message);
        }

        var fingerprint = Fingerprint(handler, target, plan.CanonicalParameters);
        if (claim.Fingerprint != fingerprint || claim.Level != handler.Level)
        {
            return Error.Conflict("VND_PREVIEW_STALE", "The action is not the one the preview showed; show the preview again.");
        }

        if (VendorActionRules.CheckConfirmation(handler.Level, body.Reason, body.TypedName, target.Name) is { } unconfirmed)
        {
            return Error.Validation(unconfirmed.Code, unconfirmed.Message);
        }

        if (VendorActionRules.CheckSwitches(Switches(handler.System), handler.Kind, target.ExternalCustomerId, credentials: false) is { } off)
        {
            return Error.Conflict(off.Code, off.Message);
        }

        var now = time.GetUtcNow();
        var notBefore = handler.Level == VendorActionLevel.Destructive ? now + VendorActionRules.DestructiveHold : now;
        var action = new VendorAction
        {
            Id = SequentialId.New(now),
            System = handler.System,
            Kind = handler.Kind,
            Level = handler.Level,
            TargetType = handler.TargetType,
            TargetId = target.Id,
            TargetName = Clip(target.Name, 256),
            OrganizationId = target.OrganizationId,
            ExternalCustomerId = target.ExternalCustomerId,
            Parameters = plan.CanonicalParameters,
            Fingerprint = fingerprint,
            Reason = handler.Level == VendorActionLevel.Standard ? null : body.Reason!.Trim(),
            RequestedBy = userId,
            RequestedAt = now,
            NotBefore = notBefore,
            CommandKey = body.CommandKey,
            OutboundOperationId = SequentialId.New(now),
            Status = handler.Level == VendorActionLevel.Destructive ? VendorActionStatus.Scheduled : VendorActionStatus.Queued,
        };
        db.VendorActions.Add(action);
        db.OutboundOperations.Add(new OutboundOperation
        {
            Id = action.OutboundOperationId,
            System = action.System,
            Operation = VendorAction.OperationFor(action.Kind),
            EntityType = VendorAction.EntityType,
            EntityId = action.Id,
            IdempotencyKey = $"{VendorAction.OperationPrefix}{action.Id:D}",
            Status = OutboundStatus.Pending,
            CreatedAt = now,
            RequestedBy = userId,
            NextAttemptAt = notBefore,
        });
        db.RecordAudit(user, request, time, AuditActions.Create, VendorAction.EntityType, action.Id, new
        {
            action.System, action.Kind, Level = action.Level.ToString(), action.TargetType, action.TargetId, action.OrganizationId, action.Reason,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // The same command arrived twice at once and the other request saved first: answer with what it saved.
            db.ChangeTracker.Clear();
            var saved = await db.VendorActions.AsNoTracking().SingleAsync(a => a.RequestedBy == userId && a.CommandKey == body.CommandKey, ct);
            return await RepeatAsync(saved, claim, ct);
        }

        return (await reader.ItemAsync(action, ct), true);
    }

    /// <summary>Withdraws an action that the worker has not taken yet: a held destructive one, or one still queued.</summary>
    public async Task<Result<VendorActionItem>> CancelAsync(Guid id, string? etag, CancellationToken ct)
    {
        var action = await db.VendorActions.SingleOrDefaultAsync(a => a.Id == id, ct);
        if (action is null || !reader.MaySee(action))
        {
            return Error.NotFound("VND_NOT_FOUND", "The action was not found.");
        }

        if (!MayChange(action))
        {
            return NotAllowed;
        }

        if (etag is null || etag != VendorActionReader.Etag(action))
        {
            return Error.PreconditionFailed("VND_STALE", "The action changed; reload it.");
        }

        if (action.Status is not (VendorActionStatus.Scheduled or VendorActionStatus.Queued))
        {
            return Error.Conflict("VND_NOT_CANCELLABLE", "Only an action the worker has not taken yet can be cancelled.");
        }

        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var now = time.GetUtcNow();
            // The worker's claim and this withdrawal both change the operation in one statement: whichever comes first wins.
            var withdrawn = await db.OutboundOperations
                .Where(o => o.Id == action.OutboundOperationId && o.Status == OutboundStatus.Pending && (o.LockedUntil == null || o.LockedUntil < now))
                .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OutboundStatus.Cancelled).SetProperty(o => o.CompletedAt, now), ct);
            if (withdrawn == 0)
            {
                return Error.Conflict("VND_SENDING", "The action is being sent right now; it can no longer be cancelled.");
            }

            action.Status = VendorActionStatus.Cancelled;
            action.OutcomeCode = "VND_CANCELLED";
            action.Outcome = "Cancelled before it was sent.";
            action.ClosedBy = user.UserId;
            action.ClosedAt = now;
            action.CompletedAt = now;
            db.RecordAudit(user, request, time, AuditActions.Cancel, VendorAction.EntityType, action.Id, new { action.System, action.Kind, action.TargetId });
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                return Error.Conflict("VND_SENDING", "The action is being sent right now; it can no longer be cancelled.");
            }

            await transaction.CommitAsync(ct);
            return Result<VendorActionItem>.Success(await reader.ItemAsync(action, ct));
        });
    }

    /// <summary>
    /// Settles an uncertain action after a person checked at the vendor: done (its operation counts as sent) or not done (cancelled),
    /// with the reason. Nothing is sent: asking again is a new action.
    /// </summary>
    public async Task<Result<VendorActionItem>> SettleAsync(Guid id, string? etag, VendorActionSettlement body, CancellationToken ct)
    {
        var action = await db.VendorActions.SingleOrDefaultAsync(a => a.Id == id, ct);
        if (action is null || !reader.MaySee(action))
        {
            return Error.NotFound("VND_NOT_FOUND", "The action was not found.");
        }

        if (!MayChange(action))
        {
            return NotAllowed;
        }

        if (etag is null || etag != VendorActionReader.Etag(action))
        {
            return Error.PreconditionFailed("VND_STALE", "The action changed; reload it.");
        }

        var done = body.Outcome switch
        {
            nameof(VendorActionStatus.Succeeded) => true,
            nameof(VendorActionStatus.Failed) => false,
            _ => (bool?)null,
        };
        var reason = body.Reason?.Trim() ?? string.Empty;
        if (done is null || reason.Length is < VendorActionRules.ReasonMinLength or > VendorActionRules.ReasonMaxLength)
        {
            return Error.Validation("VND_SETTLEMENT_INVALID", "Say whether the action happened and give a reason of 10–500 characters.");
        }

        if (action.Status != VendorActionStatus.Uncertain)
        {
            return Error.Conflict("VND_NOT_UNCERTAIN", "Only an action without a clear outcome is settled by hand.");
        }

        var now = time.GetUtcNow();
        await db.OutboundOperations.Where(o => o.Id == action.OutboundOperationId && o.Status == OutboundStatus.Failed)
            .ExecuteUpdateAsync(s => s
                .SetProperty(o => o.Status, done.Value ? OutboundStatus.Succeeded : OutboundStatus.Cancelled)
                .SetProperty(o => o.Result, done.Value ? "Confirmed at the vendor by a person." : "Not done at the vendor, by a person's check.")
                .SetProperty(o => o.CompletedAt, now), ct);
        action.Status = done.Value ? VendorActionStatus.Succeeded : VendorActionStatus.Failed;
        action.OutcomeCode = done.Value ? "VND_SETTLED_DONE" : "VND_SETTLED_NOT_DONE";
        action.Outcome = done.Value ? "A person confirmed at the vendor that it happened." : "A person confirmed at the vendor that it did not happen.";
        action.ClosedBy = user.UserId;
        action.ClosedAt = now;
        action.CloseReason = reason;
        db.RecordAudit(user, request, time, AuditActions.Update, VendorAction.EntityType, action.Id, new
        {
            action.System, action.Kind, action.TargetId, Settled = action.Status.ToString(), Reason = reason,
        });
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Error.PreconditionFailed("VND_STALE", "The action changed; reload it.");
        }

        return await reader.ItemAsync(action, ct);
    }

    private async Task<Result<(VendorActionItem Action, bool Created)>> RepeatAsync(VendorAction earlier, VendorActionPreviewClaim? claim, CancellationToken ct) =>
        claim is not null && claim.UserId == earlier.RequestedBy && claim.Fingerprint == earlier.Fingerprint
            ? (await reader.ItemAsync(earlier, ct), false)
            : Error.Conflict("VND_COMMAND_KEY_REUSED", "This command key was used for another action.");

    /// <summary>The kind's own permission; an action of a kind no longer registered is left to the integrations administrators.</summary>
    private bool MayChange(VendorAction action) =>
        Find(action.System, action.Kind, action.TargetType) is { } handler
            ? user.HasPermission(handler.Permission)
            : user.HasPermission(Crm.Authorization.Permissions.IntegrationsManage);

    private VendorActionSwitches? Switches(string system) => gates.SingleOrDefault(g => g.System == system)?.Read();

    private static string Fingerprint(IVendorActionHandler handler, VendorActionTarget target, string parameters) =>
        VendorActionRules.Fingerprint(handler.System, handler.Kind, handler.TargetType, target.Id, parameters);

    private static string Clip(string value, int length) => value.Length > length ? value[..length] : value;
}
