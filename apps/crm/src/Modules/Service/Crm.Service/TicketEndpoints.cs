using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Http;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service;

/// <summary>
/// The latest finished read of one kind of service data (M39.2): which job, when it started, whether it read everything, and whether
/// the next one is overdue. A figure whose source was never read is shown as not read, never as zero.
/// </summary>
public sealed record ServiceSourceRead(string Source, string System, DateTimeOffset? StartedAt, bool Complete, bool Late)
{
    /// <summary>The jobs that bring each kind of service data into the CRM, named as the integrations record their runs.</summary>
    internal static readonly (string Source, string System, string Job)[] Jobs =
    [
        ("tickets", "atera", "atera-tickets"),
        ("conversations", "atera", "atera-ticket-conversations"),
        ("alerts", "atera", "atera-alerts"),
        ("devices", "atera", "atera-agents"),
    ];

    internal static async Task<ServiceSourceRead> LatestAsync(IEnumerable<ISyncCompletenessSource> completeness, string source, CancellationToken ct)
    {
        var (_, system, job) = Jobs.Single(j => j.Source == source);
        foreach (var reader in completeness)
        {
            if (await reader.LatestAsync(system, job, ct) is { } latest)
            {
                return new ServiceSourceRead(source, system, latest.StartedAt, latest.Complete, latest.Late);
            }
        }

        return new ServiceSourceRead(source, system, null, false, false);
    }
}

/// <summary>
/// One ticket with what the panel shows about it (M39.2): its fields, the customer and contact names, and how fresh the ticket and its
/// conversation are — the ticket list's read and the conversation's own read time.
/// </summary>
public sealed record TicketDetail(
    Guid Id,
    string System,
    long ExternalId,
    Guid OrganizationId,
    string? OrganizationName,
    Guid? ContactId,
    string? ContactName,
    string? EndUserEmail,
    string Title,
    string Status,
    bool IsOpen,
    string? Priority,
    string? Impact,
    string? Type,
    string? Source,
    Guid? TechnicianUserId,
    string? TechnicianName,
    DateTimeOffset CreatedAt,
    DateTimeOffset? FirstResponseAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastActivityAt,
    string? Url,
    DateTimeOffset? CommentsReadAt,
    ServiceSourceRead TicketsRead,
    ServiceSourceRead ConversationsRead);

public sealed record TicketCommentItem(
    Guid Id, string ExternalId, string Text, bool IsInternal, TicketCommentAuthor Author, string? AuthorName, Guid? TechnicianUserId, DateTimeOffset CreatedAt);

/// <summary>A ticket's own read paths (M39.2): the ticket with its read times, and its conversation newest first, a page at a time.</summary>
internal static class TicketEndpoints
{
    public const int DefaultCommentLimit = 20;

    public static RouteGroupBuilder MapTicketEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/tickets/{id:guid}", async (
                Guid id, ServiceDbContext db, ICustomersApi customers, IEnumerable<ISyncCompletenessSource> completeness, CancellationToken ct) =>
            {
                if (await db.Tickets.AsNoTracking().SingleOrDefaultAsync(t => t.Id == id, ct) is not { } t)
                {
                    return Error.NotFound("SRV_TICKET_NOT_FOUND", "The ticket is not stored in the CRM.").ToProblem();
                }

                var organization = (await customers.GetOrganizationNamesAsync([t.OrganizationId], ct)).GetValueOrDefault(t.OrganizationId);
                var contact = t.ContactId is { } contactId ? (await customers.GetContactNamesAsync([contactId], ct)).GetValueOrDefault(contactId) : null;
                return Results.Ok(new TicketDetail(
                    t.Id, t.System, t.ExternalId, t.OrganizationId, organization, t.ContactId, contact ?? t.EndUserName, t.EndUserEmail, t.Title, t.Status,
                    t.IsOpen, t.Priority, t.Impact, t.Type, t.Source, t.TechnicianUserId, t.TechnicianName, t.CreatedAtSource, t.FirstResponseAt, t.ResolvedAt,
                    t.LastActivityAt, t.Url, t.CommentsReadAt,
                    await ServiceSourceRead.LatestAsync(completeness, "tickets", ct), await ServiceSourceRead.LatestAsync(completeness, "conversations", ct)));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/tickets/{id:guid}/comments", async (Guid id, string? cursor, int? limit, ServiceDbContext db, CancellationToken ct) =>
            {
                if (!await db.Tickets.AsNoTracking().AnyAsync(t => t.Id == id, ct))
                {
                    return Error.NotFound("SRV_TICKET_NOT_FOUND", "The ticket is not stored in the CRM.").ToProblem();
                }

                var comments = db.TicketComments.AsNoTracking().Where(c => c.TicketId == id);
                var total = await comments.CountAsync(ct);
                var after = KeysetCursor.Decode(cursor);
                DateTimeOffset written = default;
                if (cursor is not null && (after is null || !DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out written)))
                {
                    return Error.Validation("SRV_COMMENT_CURSOR_INVALID", "The page does not belong to this conversation.").ToProblem();
                }

                if (after is not null)
                {
                    comments = comments.Where(c => c.CreatedAtSource < written || (c.CreatedAtSource == written && c.Id.CompareTo(after.Id) < 0));
                }

                // Newest first, so the panel opens on the latest messages and loads earlier ones on request (DEV-12).
                var take = Math.Clamp(limit ?? DefaultCommentLimit, 1, KeysetCursor.MaxLimit);
                var page = await comments.OrderByDescending(c => c.CreatedAtSource).ThenByDescending(c => c.Id).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<TicketCommentItem>(
                    rows.Select(c => new TicketCommentItem(c.Id, c.ExternalId, c.Text, c.IsInternal, c.Author, c.AuthorName, c.TechnicianUserId, c.CreatedAtSource)).ToList(),
                    page.Count > take ? new KeysetCursor(rows[^1].CreatedAtSource.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null, total));
            })
            .RequirePermission(Permissions.ServiceRead);

        return group;
    }
}
