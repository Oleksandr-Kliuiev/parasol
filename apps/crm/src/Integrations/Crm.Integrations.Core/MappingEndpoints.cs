using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

public enum RecordState
{
    All,
    Unlinked,
    Linked,
}

public sealed record LinkedEntity(Guid LinkId, Guid EntityId, string? EntityName, LinkMethod Method, DateTimeOffset LinkedAt);

public sealed record MatchSuggestion(Guid EntityId, string Name, string? OrgNumber, IReadOnlyList<string> Reasons);

public sealed record ExternalRecordItem(
    Guid Id,
    string System,
    string ExternalType,
    string ExternalId,
    string DisplayName,
    string? OrgNumber,
    string? Email,
    string? Phone,
    string? Domain,
    string? ParentExternalId,
    DateTimeOffset LastSeenAt,
    DateTimeOffset? ExternalChangedAt,
    bool IsGone,
    LinkedEntity? Link,
    IReadOnlyList<MatchSuggestion> Suggestions);

public sealed record RecordPage(IReadOnlyList<ExternalRecordItem> Items, string? NextCursor, int Total, int Unlinked);

public sealed record CreateLinkRequest(string System, string ExternalType, string ExternalId, Guid EntityId);

internal sealed class CreateLinkRequestValidator : AbstractValidator<CreateLinkRequest>
{
    // Column lengths of integration.ExternalLinks (F-G1-07).
    public CreateLinkRequestValidator()
    {
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.ExternalType).NotEmpty().MaximumLength(64);
        RuleFor(x => x.ExternalId).NotEmpty().MaximumLength(128);
        RuleFor(x => x.EntityId).NotEmpty();
    }
}

public sealed record BulkResult(int Linked, int Created, int Skipped, int Failed, IReadOnlyList<string> Errors, bool DryRun);

public sealed record EntityLinkItem(Guid Id, string System, string ExternalType, string ExternalId, string? DisplayName, LinkMethod Method, DateTimeOffset LinkedAt);

public sealed record IntegrationStatusItem(
    string System,
    bool Enabled,
    IReadOnlyList<string> RecordTypes,
    int Records,
    int Unlinked,
    int PendingOutbound,
    int FailedOutbound,
    bool Paused,
    string? PauseReason,
    DateTimeOffset? PausedAt,
    string? PausedBy);

public sealed record PauseIntegrationRequest(bool Paused, string? Reason);

internal sealed class PauseIntegrationRequestValidator : AbstractValidator<PauseIntegrationRequest>
{
    // IntegrationSwitches.Reason is 512 characters (F-G1-06).
    public PauseIntegrationRequestValidator() => RuleFor(x => x.Reason).MaximumLength(512);
}


/// <summary>Mapping screen API (FR-ADM-01): external records, suggestions, links, import, bulk migration and the outbound queue.</summary>
public static class MappingEndpoints
{
    public static IEndpointRouteBuilder MapIntegrationMappingEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/integrations").WithTags("Integrations");

        group.MapGet("/status", async (IEnumerable<IIntegrationAdapter> adapters, IntegrationDbContext db, CancellationToken ct) =>
            {
                var result = new List<IntegrationStatusItem>();
                foreach (var adapter in adapters.OrderBy(a => a.System))
                {
                    var linkedIds = db.ExternalLinks.Where(l => l.System == adapter.System).Select(l => l.ExternalType + "|" + l.ExternalId);
                    var records = db.ExternalRecords.Where(r => r.System == adapter.System && !r.IsGone);
                    var pause = await db.IntegrationSwitches.AsNoTracking().SingleOrDefaultAsync(s => s.System == adapter.System, ct);
                    result.Add(new IntegrationStatusItem(
                        adapter.System,
                        adapter.IsEnabled,
                        adapter.RecordTypes.Select(t => t.ExternalType).ToList(),
                        await records.CountAsync(ct),
                        await records.CountAsync(r => !linkedIds.Contains(r.ExternalType + "|" + r.ExternalId), ct),
                        await db.OutboundOperations.CountAsync(o => o.System == adapter.System && o.Status == OutboundStatus.Pending, ct),
                        await db.OutboundOperations.CountAsync(o => o.System == adapter.System && (o.Status == OutboundStatus.Failed || o.Status == OutboundStatus.DeadLetter), ct),
                        pause?.IsPaused ?? false,
                        pause?.IsPaused == true ? pause.Reason : null,
                        pause?.IsPaused == true ? pause.PausedAt : null,
                        pause?.IsPaused == true ? pause.PausedBy : null));
                }

                return Results.Ok(result);
            })
            .RequirePermission(Permissions.IntegrationsManage);

        // What the organization card may offer: which systems are active and whether an organization can be created there.
        group.MapGet("/capabilities", (IEnumerable<IIntegrationAdapter> adapters) =>
                Results.Ok(adapters.OrderBy(a => a.System).Select(a => new
                {
                    a.System,
                    Enabled = a.IsEnabled,
                    CanCreateOrganization = a.IsEnabled && a.CreateOrganizationOperation is not null,
                }).ToList()))
            .RequirePermission(Permissions.CustomersRead);

        // Runbook 05: hold an integration during an incident without a deploy; jobs record a skipped run and the queue waits.
        group.MapPost("/{system}/pause", async (
                string system, PauseIntegrationRequest request, IEnumerable<IIntegrationAdapter> adapters, IntegrationDbContext db,
                ICurrentUser user, TimeProvider time, CancellationToken ct) =>
            {
                if (adapters.All(a => a.System != system))
                {
                    return NotFound(system);
                }

                var pause = await db.IntegrationSwitches.SingleOrDefaultAsync(s => s.System == system, ct);
                if (pause is null)
                {
                    pause = new IntegrationSwitch { System = system };
                    db.IntegrationSwitches.Add(pause);
                }

                pause.IsPaused = request.Paused;
                pause.Reason = request.Paused ? request.Reason?.Trim() : null;
                pause.PausedBy = request.Paused ? user.DisplayName : null;
                pause.PausedAt = request.Paused ? time.GetUtcNow() : null;
                await db.SaveChangesAsync(ct);
                return Results.Ok(new { system, paused = pause.IsPaused, reason = pause.Reason });
            })
            .Validate<PauseIntegrationRequest>()
            .RequirePermission(Permissions.IntegrationsManage);

        // The test is the worker's: only crm-worker holds the provider credentials (DEV-04-AC05). The request is recorded as a
        // sync run and handed over through the outbox; the page asks for the run until it has an answer.
        group.MapPost("/{system}/test", async (
                string system, IEnumerable<IIntegrationAdapter> adapters, IntegrationDbContext db, IRequestContext request, TimeProvider time, CancellationToken ct) =>
            {
                if (adapters.SingleOrDefault(a => a.System == system) is not { } adapter)
                {
                    return NotFound(system);
                }

                if (!adapter.IsEnabled)
                {
                    return Results.Ok(new ConnectionTestStatus(null, system, nameof(SyncRunStatus.Failed), false, "The integration is disabled in configuration.", null, null));
                }

                var now = time.GetUtcNow();
                var run = new SyncRun { Id = SequentialId.New(now), System = system, Job = IntegrationConnectionTestHandler.Job, StartedAt = now, Status = SyncRunStatus.Running };
                db.SyncRuns.Add(run);
                db.OutboxMessages.Add(OutboxMessage.For(new IntegrationConnectionTestRequested(system, run.Id), now, request.CorrelationId));
                await db.SaveChangesAsync(ct);
                return Results.Accepted($"/api/v1/integrations/{system}/test/{run.Id}", ConnectionTestStatus.From(run));
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapGet("/{system}/test/{id:guid}", async (string system, Guid id, IntegrationDbContext db, CancellationToken ct) =>
                await db.SyncRuns.AsNoTracking().SingleOrDefaultAsync(r => r.Id == id && r.System == system && r.Job == IntegrationConnectionTestHandler.Job, ct) is { } run
                    ? Results.Ok(ConnectionTestStatus.From(run))
                    : NotFound(id.ToString()))
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapGet("/records", async ([AsParameters] RecordQuery q, IEnumerable<IIntegrationAdapter> adapters, IntegrationDbContext db, ICustomersApi customers, ICatalogApi catalog, CancellationToken ct) =>
            {
                if (Describe(adapters, q.System, q.Type) is not { } descriptor)
                {
                    return NotFound($"{q.System}/{q.Type}");
                }

                var adapter = adapters.Single(a => a.System == q.System);
                var records = db.ExternalRecords.AsNoTracking().Where(r => r.System == q.System && r.ExternalType == q.Type);
                var links = db.ExternalLinks.AsNoTracking().Where(l => l.System == q.System && l.ExternalType == q.Type);
                if (q.IncludeGone != true)
                {
                    records = records.Where(r => !r.IsGone);
                }

                var total = await records.CountAsync(ct);
                var unlinked = await records.CountAsync(r => !links.Any(l => l.ExternalId == r.ExternalId), ct);
                records = q.State switch
                {
                    RecordState.Unlinked => records.Where(r => !links.Any(l => l.ExternalId == r.ExternalId)),
                    RecordState.Linked => records.Where(r => links.Any(l => l.ExternalId == r.ExternalId)),
                    _ => records,
                };

                if (!string.IsNullOrWhiteSpace(q.Search))
                {
                    var term = q.Search.Trim();
                    records = records.Where(r => r.DisplayName.Contains(term) || r.ExternalId == term || (r.OrgNumber != null && r.OrgNumber.Contains(term)) || (r.Email != null && r.Email.Contains(term)));
                }

                var limit = KeysetCursor.ClampLimit(q.Limit);
                if (KeysetCursor.Decode(q.Cursor) is { } cursor)
                {
                    records = records.Where(r => r.DisplayName.CompareTo(cursor.SortKey) > 0 || (r.DisplayName == cursor.SortKey && r.Id.CompareTo(cursor.Id) > 0));
                }

                var page = await records.OrderBy(r => r.DisplayName).ThenBy(r => r.Id).Take(limit + 1).ToListAsync(ct);
                var items = page.Take(limit).ToList();
                var externalIds = items.Select(r => r.ExternalId).ToList();
                var pageLinks = await links.Where(l => externalIds.Contains(l.ExternalId)).ToDictionaryAsync(l => l.ExternalId, ct);
                var names = descriptor.EntityType == EntityTypes.Organization
                    ? await customers.GetOrganizationNamesAsync(pageLinks.Values.Select(l => l.EntityId).ToList(), ct)
                    : descriptor.EntityType == EntityTypes.Contact
                        ? await customers.GetContactNamesAsync(pageLinks.Values.Select(l => l.EntityId).ToList(), ct)
                        : descriptor.EntityType == EntityTypes.Product
                            ? (await catalog.GetProductsAsync(pageLinks.Values.Select(l => l.EntityId).ToList(), ct)).ToDictionary(p => p.Key, p => $"{p.Value.Sku} {p.Value.Name}")
                            : new Dictionary<Guid, string>();

                IOrganizationMatcher? matcher = descriptor.EntityType == EntityTypes.Organization && items.Any(r => !pageLinks.ContainsKey(r.ExternalId))
                    ? await customers.CreateMatcherAsync(ct)
                    : null;
                IReadOnlyDictionary<string, Guid> contactsByEmail = descriptor.EntityType == EntityTypes.Contact
                    ? await customers.FindContactsByEmailAsync(items.Where(r => r.Email != null && !pageLinks.ContainsKey(r.ExternalId)).Select(r => r.Email!).ToList(), ct)
                    : new Dictionary<string, Guid>();
                var productCodes = descriptor.EntityType == EntityTypes.Product
                    ? items.Where(r => !pageLinks.ContainsKey(r.ExternalId)).Select(r => (r.ExternalId, Code: adapter.ToProductData(r)?.Code)).Where(x => x.Code != null).ToList()
                    : [];
                var productsBySku = productCodes.Count > 0 ? await catalog.FindProductsBySkuAsync(productCodes.Select(x => x.Code!).ToList(), ct) : new Dictionary<string, Guid>();
                var productNames = productsBySku.Count > 0 ? await catalog.GetProductsAsync(productsBySku.Values.ToList(), ct) : new Dictionary<Guid, ProductRef>();
                var contactNames = contactsByEmail.Count > 0 ? await customers.GetContactNamesAsync(contactsByEmail.Values.ToList(), ct) : new Dictionary<Guid, string>();

                var result = items.Select(r =>
                {
                    LinkedEntity? link = pageLinks.TryGetValue(r.ExternalId, out var l)
                        ? new LinkedEntity(l.Id, l.EntityId, names.GetValueOrDefault(l.EntityId), l.Method, l.LinkedAt)
                        : null;
                    IReadOnlyList<MatchSuggestion> suggestions = [];
                    if (link is null && matcher is not null && adapter.ToOrganizationData(r) is { } data)
                    {
                        suggestions = matcher.Match(data).Select(m => new MatchSuggestion(m.OrganizationId, m.Name, m.OrgNumber, m.Reasons.Select(x => x.ToString()).ToList())).ToList();
                    }
                    else if (link is null && r.Email is not null && contactsByEmail.TryGetValue(r.Email, out var contactId))
                    {
                        suggestions = [new MatchSuggestion(contactId, contactNames.GetValueOrDefault(contactId, r.Email), null, ["Email"])];
                    }
                    else if (link is null && productCodes.FirstOrDefault(x => x.ExternalId == r.ExternalId).Code is { } code &&
                             productsBySku.TryGetValue(code.Trim(), out var productId) && productNames.TryGetValue(productId, out var product))
                    {
                        suggestions = [new MatchSuggestion(productId, $"{product.Sku} {product.Name}", null, ["Sku"])];
                    }

                    return new ExternalRecordItem(r.Id, r.System, r.ExternalType, r.ExternalId, r.DisplayName, r.OrgNumber, r.Email, r.Phone, r.Domain,
                        r.ParentExternalId, r.LastSeenAt, r.ExternalChangedAt, r.IsGone, link, suggestions);
                }).ToList();

                var last = items.LastOrDefault();
                return Results.Ok(new RecordPage(result, page.Count > limit && last is not null ? new KeysetCursor(last.DisplayName, last.Id).Encode() : null, total, unlinked));
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapGet("/links", async (string entityType, Guid entityId, ExternalLinkService links, IntegrationDbContext db, CancellationToken ct) =>
            {
                var items = await links.ForEntityAsync(entityType, entityId, ct);
                var ids = items.Select(l => l.ExternalId).ToList();
                var records = await db.ExternalRecords.AsNoTracking()
                    .Where(r => ids.Contains(r.ExternalId))
                    .Select(r => new { r.System, r.ExternalType, r.ExternalId, r.DisplayName })
                    .ToListAsync(ct);
                return Results.Ok(items.Select(l => new EntityLinkItem(
                    l.Id, l.System, l.ExternalType, l.ExternalId,
                    records.FirstOrDefault(r => r.System == l.System && r.ExternalType == l.ExternalType && r.ExternalId == l.ExternalId)?.DisplayName,
                    l.Method, l.LinkedAt)).ToList());
            })
            .RequirePermission(Permissions.CustomersRead);

        group.MapPost("/links", async (CreateLinkRequest request, IEnumerable<IIntegrationAdapter> adapters, ExternalLinkService links, ICurrentUser user, CancellationToken ct) =>
            {
                if (Describe(adapters, request.System, request.ExternalType) is not { } descriptor)
                {
                    return NotFound($"{request.System}/{request.ExternalType}");
                }

                var result = await links.LinkAsync(descriptor.EntityType, request.EntityId, request.System, request.ExternalType, request.ExternalId, LinkMethod.Manual, user.UserId, ct);
                return result.ToHttpResult(link => Results.Ok(new { link.Id }));
            })
            .Validate<CreateLinkRequest>()
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapDelete("/links/{id:guid}", async (Guid id, ExternalLinkService links, CancellationToken ct) =>
                await links.UnlinkAsync(id, ct) ? Results.NoContent() : NotFound(id.ToString()))
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/records/{system}/{type}/{externalId}/import", async (
                string system, string type, string externalId, ExternalImportService import, CancellationToken ct) =>
                (await import.ImportOneAsync(system, type, externalId, ct)).ToHttpResult(id => Results.Ok(new { entityId = id })))
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/records/{system}/{type}/auto-link", async (string system, string type, ExternalImportService import, CancellationToken ct) =>
                (await import.AutoLinkAsync(system, type, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/records/{system}/{type}/import-unlinked", async (string system, string type, bool? dryRun, ExternalImportService import, CancellationToken ct) =>
                (await import.ImportUnlinkedAsync(system, type, dryRun ?? true, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/{system}/organizations/{organizationId:guid}/export", async (
                string system, Guid organizationId, IEnumerable<IIntegrationAdapter> adapters, ExternalLinkService links, OutboundQueue queue, ICurrentUser user, CancellationToken ct) =>
            {
                if (adapters.SingleOrDefault(a => a.System == system) is not { IsEnabled: true, CreateOrganizationOperation: { } operation } adapter)
                {
                    return Error.Validation("INT_EXPORT_UNAVAILABLE", $"Creating organizations in '{system}' is not enabled.").ToProblem();
                }

                var customerType = adapter.RecordTypes.First(t => t.EntityType == EntityTypes.Organization).ExternalType;
                if (await links.FindByEntityAsync(EntityTypes.Organization, organizationId, system, customerType, ct) is not null)
                {
                    return Error.Conflict("INT_ENTITY_ALREADY_LINKED", "The organization is already linked to a record in this system.").ToProblem();
                }

                var queued = await queue.EnqueueAsync(system, operation, EntityTypes.Organization, organizationId, user.UserId, ct);
                return Results.Accepted(value: new { operationId = queued.Id });
            })
            .RequirePermission(Permissions.CustomersWrite);

        group.MapGet("/outbound", async (OutboundStatus? status, string? system, int? limit, string? cursor, IntegrationDbContext db, CancellationToken ct) =>
            {
                var query = db.OutboundOperations.AsNoTracking();
                if (status is { } s)
                {
                    query = query.Where(o => o.Status == s);
                }

                if (!string.IsNullOrWhiteSpace(system))
                {
                    query = query.Where(o => o.System == system);
                }

                // Newest first, then id (DEV-12): a page per request and the count of all.
                var total = await query.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after &&
                    DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
                {
                    query = query.Where(o => o.CreatedAt < created || (o.CreatedAt == created && o.Id.CompareTo(after.Id) < 0));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await query.OrderByDescending(o => o.CreatedAt).ThenByDescending(o => o.Id).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<OutboundOperationItem>(
                    rows.Select(OutboundOperationItem.From).ToList(),
                    page.Count > take ? new KeysetCursor(rows[^1].CreatedAt.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null, total));
            })
            .RequirePermission(Permissions.IntegrationsManage);

        // DEV-07: who sent an operation back or withdrew it is recorded with the change, in one transaction.
        group.MapPost("/outbound/{id:guid}/retry", async (
                Guid id, OutboundRetryReason body, HttpRequest httpRequest, IntegrationDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time, CancellationToken ct) =>
            {
                if (httpRequest.GetIfMatch() is not { } etag) return HeaderExtensions.PreconditionRequired();
                var operation = await db.OutboundOperations.AsNoTracking().SingleOrDefaultAsync(
                    o => o.Id == id && (o.Status == OutboundStatus.Failed || o.Status == OutboundStatus.DeadLetter), ct);
                if (operation is null)
                {
                    return NotFound(id.ToString());
                }

                if (operation.Operation.StartsWith(Actions.VendorAction.OperationPrefix, StringComparison.Ordinal))
                {
                    return ActionOperation();
                }

                if (etag != OutboundOperationItem.Version(operation))
                    return Error.PreconditionFailed("INT_RETRY_STALE", "The operation changed. Reload before retrying.").ToProblem();
                var reason = body.Reason?.Trim() ?? string.Empty;
                if (reason.Length is < 10 or > 500)
                    return Error.Validation("INT_RETRY_REASON", "Give a retry reason of 10–500 characters.").ToProblem();
                return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
                {
                    await using var transaction = await db.Database.BeginTransactionAsync(ct);
                    var now = time.GetUtcNow();
                    var changed = await db.OutboundOperations.Where(o => o.Id == id && o.Status == operation.Status &&
                        o.Attempts == operation.Attempts && o.CompletedAt == operation.CompletedAt && o.NextAttemptAt == operation.NextAttemptAt &&
                        o.LockedUntil == operation.LockedUntil && o.LeaseOwner == operation.LeaseOwner &&
                        (o.LockedUntil == null || o.LockedUntil < now)).ExecuteUpdateAsync(s => s
                        .SetProperty(o => o.Status, OutboundStatus.Pending).SetProperty(o => o.Attempts, 0)
                        .SetProperty(o => o.NextAttemptAt, now).SetProperty(o => o.CompletedAt, (DateTimeOffset?)null)
                        .SetProperty(o => o.LockedUntil, (DateTimeOffset?)null).SetProperty(o => o.LeaseOwner, (Guid?)null)
                        .SetProperty(o => o.LastError, (string?)null), ct);
                    if (changed == 0)
                        return Error.PreconditionFailed("INT_RETRY_STALE", "The operation changed. Reload before retrying.").ToProblem();
                    db.RecordAudit(user, request, time, AuditActions.Replay, nameof(OutboundOperation), id, new
                    {
                        Reason = reason, operation.System, operation.Operation, operation.EntityId, Previous = operation.Status.ToString(), operation.Attempts,
                    });
                    await db.SaveChangesAsync(ct);
                    await transaction.CommitAsync(ct);
                    return Results.NoContent();
                });
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/outbound/{id:guid}/cancel", async (
                Guid id, IntegrationDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time, CancellationToken ct) =>
            {
                // A run that holds the operation finishes first: withdrawing it under that run would race the send, and the
                // run would record its own outcome over the withdrawal. The condition is part of the update itself.
                var now = time.GetUtcNow();
                var operation = await db.OutboundOperations.AsNoTracking().SingleOrDefaultAsync(
                    o => o.Id == id && o.Status != OutboundStatus.Succeeded && o.Status != OutboundStatus.Cancelled, ct);
                if (operation is null)
                {
                    return NotFound(id.ToString());
                }

                if (operation.Operation.StartsWith(Actions.VendorAction.OperationPrefix, StringComparison.Ordinal))
                {
                    return ActionOperation();
                }

                return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
                {
                    await using var transaction = await db.Database.BeginTransactionAsync(ct);
                    var cancelled = await db.OutboundOperations
                        .Where(o => o.Id == id && o.Status == operation.Status && (o.LockedUntil == null || o.LockedUntil < now))
                        .ExecuteUpdateAsync(u => u.SetProperty(o => o.Status, OutboundStatus.Cancelled).SetProperty(o => o.CompletedAt, now), ct);
                    if (cancelled == 0)
                    {
                        return Error.Conflict("INT_OUTBOUND_RUNNING", "The operation is being sent or changed right now; reload and try again.").ToProblem();
                    }

                    db.RecordAudit(user, request, time, AuditActions.Cancel, nameof(OutboundOperation), id, new
                    {
                        operation.System, operation.Operation, operation.EntityId, Previous = operation.Status.ToString(), operation.Attempts,
                    });
                    await db.SaveChangesAsync(ct);
                    await transaction.CommitAsync(ct);
                    return Results.NoContent();
                });
            })
            .RequirePermission(Permissions.IntegrationsManage);

        return app;
    }

    internal static ExternalTypeDescriptor? Describe(IEnumerable<IIntegrationAdapter> adapters, string? system, string? type) =>
        adapters.SelectMany(a => a.RecordTypes).SingleOrDefault(t => t.System == system && t.ExternalType == type);

    /// <summary>
    /// A vendor action is cancelled during its hold or settled in the action log (M39.1): a retry from here could send a comment twice,
    /// and a cancel here would leave its action waiting.
    /// </summary>
    private static IResult ActionOperation() =>
        Error.Conflict("INT_OUTBOUND_IS_ACTION", "This operation carries a vendor action; cancel or settle it in the action log.").ToProblem();

    private static IResult NotFound(string what) =>
        Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "INT_NOT_FOUND", detail: $"'{what}' was not found.",
            extensions: new Dictionary<string, object?> { ["code"] = "INT_NOT_FOUND" });
}

public sealed record RecordQuery(
    [FromQuery] string System,
    [FromQuery] string Type,
    [FromQuery] RecordState? State,
    [FromQuery] string? Search,
    [FromQuery] bool? IncludeGone,
    [FromQuery] string? Cursor,
    [FromQuery] int? Limit);

public sealed record OutboundRetryReason(string? Reason);

/// <summary>Safe operator view with the exact delivery generation the operator is confirming.</summary>
public sealed record OutboundOperationItem(
    Guid Id, string System, string Operation, string EntityType, Guid EntityId, string IdempotencyKey,
    OutboundStatus Status, int Attempts, DateTimeOffset CreatedAt, Guid? RequestedBy, DateTimeOffset NextAttemptAt,
    DateTimeOffset? LockedUntil, Guid? LeaseOwner, DateTimeOffset? CompletedAt, string? LastError, string? Result, string Etag)
{
    public static OutboundOperationItem From(OutboundOperation operation) => new(
        operation.Id, operation.System, operation.Operation, operation.EntityType, operation.EntityId, operation.IdempotencyKey,
        operation.Status, operation.Attempts, operation.CreatedAt, operation.RequestedBy, operation.NextAttemptAt,
        operation.LockedUntil, operation.LeaseOwner, operation.CompletedAt,
        operation.LastError is null ? null : "Outbound operation failed.", null, Version(operation));

    // Includes the outcome timestamp and next-attempt time, so Failed -> Pending -> Failed cannot reuse a confirmation,
    // even when attempts and status repeat. The token contains neither provider errors nor their hashes.
    public static string Version(OutboundOperation operation) => '"' + Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
    {
        operation.Id, operation.Status, operation.Attempts, operation.CompletedAt, operation.NextAttemptAt, operation.LockedUntil, operation.LeaseOwner,
    }))) + '"';
}
