using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core.Persistence;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

/// <summary>
/// One action in the log, with the names of its customer and of the people who asked for and closed it. <c>TicketId</c> is Parasoll's
/// ticket the action concerns (its target, or the ticket its hours were recorded on) and <c>VendorUrl</c> where to check it at the vendor.
/// </summary>
public sealed record VendorActionItem(
    Guid Id,
    string System,
    string Kind,
    VendorActionLevel Level,
    string TargetType,
    string TargetId,
    string TargetName,
    Guid? OrganizationId,
    string? OrganizationName,
    JsonElement Parameters,
    string? Reason,
    VendorActionStatus Status,
    string? OutcomeCode,
    string? Outcome,
    string? Reference,
    int Attempts,
    Guid RequestedBy,
    string? RequestedByName,
    DateTimeOffset RequestedAt,
    DateTimeOffset NotBefore,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt,
    Guid? ClosedBy,
    string? ClosedByName,
    DateTimeOffset? ClosedAt,
    string? CloseReason,
    Guid? TicketId,
    string? VendorUrl,
    string Etag,
    Guid? BatchId = null);

/// <summary>A page of the log; <c>Uncertain</c> and <c>Waiting</c> count the whole filter, as the log's header says them.</summary>
public sealed record VendorActionPage(IReadOnlyList<VendorActionItem> Items, string? NextCursor, int TotalCount, int Uncertain, int Waiting);

/// <summary>
/// The action log (M39.1): newest first, for <c>/connections</c> (every action, <c>integrations.manage</c>) and for a target's own
/// panel (the kinds whose read permission the caller holds). Names and tickets come in one batch per page, and so do the facts a list
/// shows beside its rows (<see cref="LookupAsync"/>).
/// </summary>
public sealed class VendorActionReader(
    IntegrationDbContext db, IEnumerable<IVendorActionHandler> handlers, IUserDirectory users, ICustomersApi customers, IServiceApi service, ICurrentUser user)
{
    /// <summary>The targets one lookup may carry: a page of a list.</summary>
    public const int LookupLimit = 50;

    public const int DefaultLimit = 25;
    public const int MaxLimit = 100;

    private static readonly VendorActionStatus[] Waiting = [VendorActionStatus.Scheduled, VendorActionStatus.Queued, VendorActionStatus.Sending];

    public static string Etag(VendorAction action) => $"\"{Convert.ToBase64String(action.RowVersion)}\"";

    public bool MaySee(VendorAction action) =>
        user.HasPermission(Permissions.IntegrationsManage) || handlers.Any(h =>
            h.System == action.System && h.Kind == action.Kind && h.TargetType == action.TargetType && user.HasPermission(h.ReadPermission));

    /// <param name="state"><c>attention</c> (uncertain), <c>waiting</c> (not sent yet) or empty for every action.</param>
    public async Task<Result<VendorActionPage>> ListAsync(
        string? system, string? targetType, string? targetId, Guid? organizationId, string? state, string? cursor, int? limit, CancellationToken ct)
    {
        if (state is not (null or "" or "attention" or "waiting"))
        {
            return Error.Validation("VND_FILTER_INVALID", "Unknown state; use attention or waiting.");
        }

        var actions = Visible();
        if (!string.IsNullOrWhiteSpace(system))
        {
            actions = actions.Where(a => a.System == system);
        }

        if (!string.IsNullOrWhiteSpace(targetType) && !string.IsNullOrWhiteSpace(targetId))
        {
            actions = actions.Where(a => a.TargetType == targetType && a.TargetId == targetId);
        }

        if (organizationId is { } organization)
        {
            actions = actions.Where(a => a.OrganizationId == organization);
        }

        actions = state switch
        {
            "attention" => actions.Where(a => a.Status == VendorActionStatus.Uncertain),
            "waiting" => actions.Where(a => Waiting.Contains(a.Status)),
            _ => actions,
        };

        var after = KeysetCursor.Decode(cursor);
        DateTimeOffset requested = default;
        if (cursor is not null && (after is null || !DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out requested)))
        {
            return Error.Validation("VND_CURSOR_INVALID", "The page does not belong to this list.");
        }

        var counts = await actions.GroupBy(a => a.Status).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
        if (after is not null)
        {
            actions = actions.Where(a => a.RequestedAt < requested || (a.RequestedAt == requested && a.Id.CompareTo(after.Id) < 0));
        }

        var take = Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
        var page = await actions.OrderByDescending(a => a.RequestedAt).ThenByDescending(a => a.Id).Take(take + 1).ToListAsync(ct);
        var rows = page.Take(take).ToList();
        var next = page.Count > take ? new KeysetCursor(rows[^1].RequestedAt.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null;
        return new VendorActionPage(await ItemsAsync(rows, ct), next, counts.Sum(c => c.Count),
            counts.Where(c => c.Key == VendorActionStatus.Uncertain).Sum(c => c.Count), counts.Where(c => Waiting.Contains(c.Key)).Sum(c => c.Count));
    }

    public async Task<Result<VendorActionItem>> GetAsync(Guid id, CancellationToken ct) =>
        await Visible().SingleOrDefaultAsync(a => a.Id == id, ct) is { } action
            ? await ItemAsync(action, ct)
            : Error.NotFound("VND_NOT_FOUND", "The action was not found.");

    public async Task<VendorActionItem> ItemAsync(VendorAction action, CancellationToken ct) => (await ItemsAsync([action], ct))[0];

    /// <summary>
    /// The action facts of one page of targets, read at once (M39): how many actions on each wait for the worker, were done or need a
    /// check, and the newest that needs one. Only the kinds the caller may read count; a target without any is left out.
    /// </summary>
    public async Task<VendorActionLookup> LookupAsync(VendorActionLookupRequest request, CancellationToken ct)
    {
        var ids = request.TargetIds!.Distinct(StringComparer.Ordinal).ToList();
        var actions = Visible().Where(a => a.System == request.System && a.TargetType == request.TargetType && ids.Contains(a.TargetId));
        var counts = await actions.GroupBy(a => new { a.TargetId, a.Status }).Select(g => new { g.Key.TargetId, g.Key.Status, Count = g.Count() }).ToListAsync(ct);
        // Actions that wait for a person are few: the newest per target is picked here, not in SQL.
        var checks = await actions.Where(a => a.Status == VendorActionStatus.Uncertain)
            .OrderByDescending(a => a.RequestedAt).ThenByDescending(a => a.Id).Select(a => new { a.TargetId, a.Id }).ToListAsync(ct);
        return new VendorActionLookup([
            .. counts.GroupBy(c => c.TargetId, StringComparer.Ordinal).OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => new VendorActionTargetFacts(
                g.Key,
                g.Where(c => Waiting.Contains(c.Status)).Sum(c => c.Count),
                g.Where(c => c.Status is VendorActionStatus.Succeeded or VendorActionStatus.Skipped).Sum(c => c.Count),
                g.Where(c => c.Status == VendorActionStatus.Uncertain).Sum(c => c.Count),
                checks.FirstOrDefault(c => string.Equals(c.TargetId, g.Key, StringComparison.Ordinal))?.Id)),
        ]);
    }

    /// <summary>
    /// A batch as it stands now (M45): how many of its actions wait and how many came to each outcome, and with
    /// <paramref name="withItems"/> every action of it in the order asked, so a dialog says what happened to each target. Only actions the
    /// caller may read count; a batch with none of them is not found.
    /// </summary>
    public async Task<Result<VendorActionBatchState>> BatchAsync(Guid batchId, bool withItems, CancellationToken ct)
    {
        var actions = Visible().Where(a => a.BatchId == batchId);
        var counts = await actions.GroupBy(a => new { a.System, a.Kind, a.Status })
            .Select(g => new { g.Key.System, g.Key.Kind, g.Key.Status, Count = g.Count() }).ToListAsync(ct);
        if (counts.Count == 0)
        {
            return Error.NotFound("VND_BATCH_NOT_FOUND", "The batch was not found.");
        }

        int Count(params VendorActionStatus[] statuses) => counts.Where(c => statuses.Contains(c.Status)).Sum(c => c.Count);
        IReadOnlyList<VendorActionBatchEntry> items = [];
        if (withItems)
        {
            var rows = await actions.OrderBy(a => a.Id)
                .Select(a => new { a.Id, a.TargetId, a.TargetName, a.OrganizationId, a.Status, a.OutcomeCode, a.CompletedAt }).ToListAsync(ct);
            var organizations = await customers.GetOrganizationNamesAsync(
                rows.Where(r => r.OrganizationId != null).Select(r => r.OrganizationId!.Value).Distinct().ToList(), ct);
            items = rows.Select(r => new VendorActionBatchEntry(r.Id, r.TargetId, r.TargetName, r.OrganizationId,
                r.OrganizationId is { } organization ? organizations.GetValueOrDefault(organization) : null, r.Status, r.OutcomeCode, r.CompletedAt)).ToList();
        }

        return new VendorActionBatchState(batchId, counts[0].System, counts[0].Kind, counts.Sum(c => c.Count), Count(Waiting),
            Count(VendorActionStatus.Succeeded), Count(VendorActionStatus.Skipped), Count(VendorActionStatus.Simulated),
            Count(VendorActionStatus.Rejected, VendorActionStatus.Failed, VendorActionStatus.Cancelled), Count(VendorActionStatus.Uncertain), items);
    }

    /// <summary>Every action for the integrations administrators; for others only the kinds whose read permission they hold.</summary>
    private IQueryable<VendorAction> Visible()
    {
        var actions = db.VendorActions.AsNoTracking();
        if (user.HasPermission(Permissions.IntegrationsManage))
        {
            return actions;
        }

        var kinds = handlers.Where(h => user.HasPermission(h.ReadPermission)).Select(h => $"{h.System}/{h.Kind}").Distinct().ToList();
        return actions.Where(a => kinds.Contains(a.System + "/" + a.Kind));
    }

    private async Task<IReadOnlyList<VendorActionItem>> ItemsAsync(List<VendorAction> rows, CancellationToken ct)
    {
        if (rows.Count == 0)
        {
            return [];
        }

        var people = await users.GetUsersAsync(rows.Select(r => r.RequestedBy).Concat(rows.Where(r => r.ClosedBy != null).Select(r => r.ClosedBy!.Value))
            .Distinct().ToList(), ct);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Where(r => r.OrganizationId != null).Select(r => r.OrganizationId!.Value).Distinct().ToList(), ct);
        var tickets = await TicketsAsync(rows, ct);
        return rows.Select(a => new VendorActionItem(
            a.Id, a.System, a.Kind, a.Level, a.TargetType, a.TargetId, a.TargetName, a.OrganizationId,
            a.OrganizationId is { } organization ? organizations.GetValueOrDefault(organization) : null,
            JsonDocument.Parse(a.Parameters).RootElement.Clone(), a.Reason, a.Status, a.OutcomeCode, a.Outcome, a.Reference, a.Attempts,
            a.RequestedBy, people.GetValueOrDefault(a.RequestedBy)?.DisplayName, a.RequestedAt, a.NotBefore, a.StartedAt, a.CompletedAt,
            a.ClosedBy, a.ClosedBy is { } closer ? people.GetValueOrDefault(closer)?.DisplayName : null, a.ClosedAt, a.CloseReason,
            tickets.GetValueOrDefault(a.Id)?.Id, tickets.GetValueOrDefault(a.Id)?.Url, Etag(a), a.BatchId)).ToList();
    }

    /// <summary>The saved ticket each action concerns, read per vendor in one batch for the page.</summary>
    private async Task<Dictionary<Guid, TicketRef>> TicketsAsync(List<VendorAction> rows, CancellationToken ct)
    {
        var concerned = rows.Select(a => (Action: a, Number: VendorActionTargets.TicketOf(a))).Where(x => x.Number is not null).ToList();
        var tickets = new Dictionary<Guid, TicketRef>();
        foreach (var system in concerned.GroupBy(x => x.Action.System, StringComparer.Ordinal))
        {
            var saved = await service.GetTicketsAsync(system.Key, system.Select(x => x.Number!.Value).Distinct().ToList(), ct);
            foreach (var (action, number) in system)
            {
                if (saved.TryGetValue(number!.Value, out var ticket))
                {
                    tickets[action.Id] = ticket;
                }
            }
        }

        return tickets;
    }
}
