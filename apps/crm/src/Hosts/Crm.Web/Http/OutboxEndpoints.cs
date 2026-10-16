using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Web.Http;

/// <summary>One undelivered domain event, without its payload: the payload may carry personal data (DEV-07).</summary>
public sealed record OutboxMessageItem(
    Guid Id,
    string Module,
    string EventType,
    OutboxStatus Status,
    DateTimeOffset OccurredAt,
    int Attempts,
    int Replays,
    DateTimeOffset? NextAttemptAt,
    DateTimeOffset? DeadLetteredAt,
    string? LastError,
    IReadOnlyList<string> DeliveredHandlers,
    int PayloadBytes,
    IReadOnlyList<string> PayloadFields,
    bool ReplayRequested);

public sealed record OutboxModuleCount(string Module, int Pending, int Processing, int DeadLetter, int Quarantined);

public sealed record OutboxOverview(IReadOnlyList<OutboxModuleCount> Counts, IReadOnlyList<OutboxMessageItem> Items);

public sealed record OutboxMessageRef(string Module, Guid Id, int? Replays);

/// <summary>
/// What a person confirmed: these messages, this many of them, for this reason. The server replays nothing else and refuses
/// when the list no longer matches what can be replayed.
/// </summary>
public sealed record ReplayOutboxRequest(IReadOnlyList<OutboxMessageRef>? Messages, string? Reason, int Expected);

public sealed record ReplayOutboxItem(string Module, Guid Id, string Status);

public sealed record ReplayOutboxResponse(int Requested, IReadOnlyList<string> Modules, IReadOnlyList<ReplayOutboxItem> Items);

/// <summary>
/// Delivery diagnostics and replay of the domain outbox for administrators (DEV-07). The web host only reads the outbox and
/// files a replay request with its audit entry; crm-worker applies it, as the web role may not change outbox rows (DEV-04).
/// A replay delivers the stored payload unchanged — there is no way to submit a type or JSON of one's own.
/// </summary>
public static class OutboxEndpoints
{
    public const int MaxListed = 200;
    public const int MinReasonLength = 10;
    public const int MaxReasonLength = 500;

    public static IEndpointRouteBuilder MapOutboxEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/integrations/outbox").WithTags("Integrations");

        group.MapGet("/", async (OutboxStatus? status, string? module, int? limit, HttpContext http, ModuleDbContextRegistry registry, CancellationToken ct) =>
            {
                var statuses = status is { } wanted ? [wanted] : new[] { OutboxStatus.DeadLetter, OutboxStatus.Quarantined };
                var take = Math.Clamp(limit ?? MaxListed, 1, MaxListed);
                var counts = new List<OutboxModuleCount>();
                var items = new List<OutboxMessageItem>();
                foreach (var context in Contexts(http, registry))
                {
                    var byStatus = await context.OutboxMessages.AsNoTracking()
                        .Where(m => m.ProcessedAt == null)
                        .GroupBy(m => m.Status)
                        .Select(g => new { Status = g.Key, Count = g.Count() })
                        .ToDictionaryAsync(g => g.Status, g => g.Count, ct);
                    counts.Add(new OutboxModuleCount(
                        context.Schema,
                        byStatus.GetValueOrDefault(OutboxStatus.Pending),
                        byStatus.GetValueOrDefault(OutboxStatus.Processing),
                        byStatus.GetValueOrDefault(OutboxStatus.DeadLetter),
                        byStatus.GetValueOrDefault(OutboxStatus.Quarantined)));

                    if (module is not null && !string.Equals(module, context.Schema, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    var requested = await RequestedAsync(context, ct);
                    var messages = await context.OutboxMessages.AsNoTracking()
                        .Where(m => m.ProcessedAt == null && statuses.Contains(m.Status))
                        .OrderByDescending(m => m.OccurredAt)
                        .Take(take)
                        .ToListAsync(ct);
                    items.AddRange(messages.Select(m => Describe(context.Schema, m, requested.Contains(m.Id))));
                }

                return Results.Ok(new OutboxOverview(counts, items.OrderByDescending(i => i.OccurredAt).Take(take).ToList()));
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPost("/replay", async (
                ReplayOutboxRequest request, HttpContext http, ModuleDbContextRegistry registry, ICurrentUser user, IRequestContext requestContext,
                TimeProvider time, CancellationToken ct) =>
            {
                var reason = request.Reason?.Trim() ?? string.Empty;
                if (reason.Length is < MinReasonLength or > MaxReasonLength)
                {
                    return Error.Validation("OUTBOX_REPLAY_REASON", $"Say why the messages are replayed ({MinReasonLength}–{MaxReasonLength} characters).").ToProblem();
                }

                if (request.Messages?.Any(m => m is null || string.IsNullOrWhiteSpace(m.Module)) == true)
                    return Error.Validation("OUTBOX_UNKNOWN_MODULE", "Every selected message must name its module.").ToProblem();
                var selected = (request.Messages ?? []).DistinctBy(m => (m.Module.ToLowerInvariant(), m.Id)).ToList();
                if (selected.Count is 0 or > OutboxReplayRequest.MaxMessages)
                {
                    return Error.Validation("OUTBOX_REPLAY_LIMIT", $"Replay between 1 and {OutboxReplayRequest.MaxMessages} messages at a time.").ToProblem();
                }

                var contexts = Contexts(http, registry).ToDictionary(c => c.Schema, StringComparer.OrdinalIgnoreCase);
                if (selected.FirstOrDefault(m => !contexts.ContainsKey(m.Module)) is { } unknown)
                {
                    return Error.Validation("OUTBOX_UNKNOWN_MODULE", $"There is no module '{unknown.Module}'.").ToProblem();
                }

                // A database session lock serializes replay requests across web replicas, including the absent request row.
                // Per-module transactions remain independent, exactly as worker application is; all results name the records.
                var lockContext = contexts.Values.First();
                await lockContext.Database.OpenConnectionAsync(ct);
                try
                {
                    await lockContext.Database.ExecuteSqlRawAsync("DECLARE @result int; EXEC @result = sys.sp_getapplock @Resource=N'crm-outbox-replay', @LockMode=N'Exclusive', @LockOwner=N'Session', @LockTimeout=10000; IF @result < 0 THROW 51000, 'Replay selection is busy.', 1;", ct);
                    // What the person saw and confirmed must still be what can be replayed: dead or quarantined, not yet requested.
                    var plan = new List<(ModuleDbContext Context, List<OutboxMessage> Messages)>();
                    foreach (var group in selected.GroupBy(m => contexts[m.Module].Schema))
                    {
                        var context = contexts[group.Key];
                        var ids = group.Select(m => m.Id).ToList();
                        var requested = await RequestedAsync(context, ct);
                        var replayable = await context.OutboxMessages.AsNoTracking()
                            .Where(m => ids.Contains(m.Id) && m.ProcessedAt == null && (m.Status == OutboxStatus.DeadLetter || m.Status == OutboxStatus.Quarantined))
                            .ToListAsync(ct);
                        plan.Add((context, replayable.Where(m => !requested.Contains(m.Id) &&
                            group.Single(s => s.Id == m.Id).Replays == m.Replays).ToList()));
                    }

                    var replayableCount = plan.Sum(p => p.Messages.Count);
                    if (request.Expected != selected.Count || replayableCount != selected.Count)
                    {
                        var available = plan.SelectMany(p => p.Messages.Select(m => (p.Context.Schema, m.Id))).ToHashSet();
                        return new Error(
                            "OUTBOX_REPLAY_STALE",
                            $"{replayableCount} of the {selected.Count} selected messages can be replayed now (confirmed: {request.Expected}). Reload the list and confirm again.",
                            ErrorType.Conflict, new Dictionary<string, object?>
                            {
                                ["items"] = selected.Select(m => new ReplayOutboxItem(m.Module, m.Id,
                                    available.Contains((contexts[m.Module].Schema, m.Id)) ? "Available" : "Unavailable")).ToList(),
                            }).ToProblem();
                    }

                    // One request and one audit entry per module, each in that module's transaction.
                    var now = time.GetUtcNow();
                    var completedModules = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    foreach (var (context, messages) in plan)
                    {
                        var replay = new OutboxReplayRequest
                        {
                            Id = SequentialId.New(now),
                            MessageIds = string.Join(',', messages.Select(m => m.Id)),
                            Expected = messages.Count,
                            Reason = reason,
                            RequestedBy = user.UserId,
                            RequestedByName = user.DisplayName,
                            RequestedAt = now,
                        };
                        context.OutboxReplayRequests.Add(replay);
                        context.RecordAudit(user, requestContext, time, AuditActions.Replay, nameof(OutboxMessage), replay.Id, new
                        {
                            Reason = reason,
                            Messages = messages.Select(m => new { m.Id, EventType = ShortType(m.Type), Status = m.Status.ToString(), m.Attempts }).ToList(),
                        });
                        try
                        {
                            await context.SaveChangesAsync(ct);
                            completedModules.Add(context.Schema);
                        }
                        catch (Exception) when (!ct.IsCancellationRequested)
                        {
                            // A lost commit acknowledgement is indistinguishable from a failed write. Name that module
                            // Unknown, not failed: refresh the durable requests before confirming a new selection.
                            return new Error("OUTBOX_REPLAY_PARTIAL", "Replay results could not be confirmed for every module. Reload before retrying.",
                                ErrorType.Conflict, new Dictionary<string, object?>
                                {
                                    ["items"] = selected.Select(m => new ReplayOutboxItem(m.Module, m.Id,
                                        completedModules.Contains(m.Module) ? "Requested" : contexts[m.Module].Schema == context.Schema ? "Unknown" : "NotRequested")).ToList(),
                                }).ToProblem();
                        }
                    }

                    return Results.Accepted(value: new ReplayOutboxResponse(replayableCount, plan.Select(p => p.Context.Schema).ToList(),
                        selected.Select(m => new ReplayOutboxItem(m.Module, m.Id, "Requested")).ToList()));
                }
                finally
                {
                    await lockContext.Database.ExecuteSqlRawAsync("EXEC sys.sp_releaseapplock @Resource=N'crm-outbox-replay', @LockOwner=N'Session';", CancellationToken.None);
                    await lockContext.Database.CloseConnectionAsync();
                }
            })
            .RequirePermission(Permissions.IntegrationsManage);

        return app;
    }

    private static IEnumerable<ModuleDbContext> Contexts(HttpContext http, ModuleDbContextRegistry registry) =>
        registry.Contexts.Select(type => (ModuleDbContext)http.RequestServices.GetRequiredService(type));

    private static async Task<HashSet<Guid>> RequestedAsync(ModuleDbContext context, CancellationToken ct)
    {
        var pending = await context.OutboxReplayRequests.AsNoTracking().Where(r => r.AppliedAt == null).Select(r => r.MessageIds).ToListAsync(ct);
        return pending.SelectMany(ids => ids.Split(',', StringSplitOptions.RemoveEmptyEntries))
            .Select(value => Guid.TryParse(value, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty)
            .ToHashSet();
    }

    internal static OutboxMessageItem Describe(string module, OutboxMessage message, bool replayRequested) => new(
        message.Id,
        module,
        ShortType(message.Type),
        message.Status,
        message.OccurredAt,
        message.Attempts,
        message.Replays,
        message.NextAttemptAt,
        message.DeadLetteredAt,
        message.LastError is null ? null : "Delivery failed. Inspect the event type and handler diagnostics.",
        (message.DeliveredHandlers ?? string.Empty).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(h => h[(h.LastIndexOf('.') + 1)..]).ToList(),
        Encoding.UTF8.GetByteCount(message.Payload),
        PayloadFields(message.Payload),
        replayRequested);

    /// <summary>"Crm.Sales.Contracts.QuoteAccepted, Crm.Sales.Contracts" → "QuoteAccepted".</summary>
    internal static string ShortType(string type)
    {
        var name = type.Split(',')[0];
        return name[(name.LastIndexOf('.') + 1)..];
    }

    /// <summary>The names of the payload's top-level fields, never their values; empty when the payload is not a JSON object.</summary>
    internal static IReadOnlyList<string> PayloadFields(string payload)
    {
        try
        {
            using var document = JsonDocument.Parse(payload);
            return document.RootElement.ValueKind == JsonValueKind.Object
                ? document.RootElement.EnumerateObject().Select(p => p.Name).ToList()
                : [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
