using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features;

/// <summary>
/// The mirror of tickets' conversations (M39.2). Only a complete read of one ticket's conversation is applied, so a comment the desk
/// no longer lists is removed with confidence; a read of the ticket list never touches comments. The ticket remembers when its
/// conversation was read, which is what the panel says and what tells the reader which open tickets to look at again.
/// </summary>
internal sealed class TicketConversations(ServiceDbContext db, TimeProvider time)
{
    public async Task<TicketConversationResult> ApplyAsync(
        string system, long ticketExternalId, IReadOnlyCollection<ExternalTicketComment> comments, bool withheld, CancellationToken ct)
    {
        // The ticket reads and every read of a conversation write one at a time (TicketWriteLock).
        try
        {
            return await TicketWriteLock.RunAsync(db, system, c => ApplyOnceAsync(system, ticketExternalId, comments, withheld, c), ct);
        }
        catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || ex.InnerException is SqlException { Number: 2601 or 2627 })
        {
            // A writer outside the reads (a merge, an erasure) saved in between: read the stored state again, once.
            db.ChangeTracker.Clear();
            return await TicketWriteLock.RunAsync(db, system, c => ApplyOnceAsync(system, ticketExternalId, comments, withheld, c), ct);
        }
    }

    private async Task<TicketConversationResult> ApplyOnceAsync(
        string system, long ticketExternalId, IReadOnlyCollection<ExternalTicketComment> comments, bool withheld, CancellationToken ct)
    {
        var ticket = await db.Tickets.SingleOrDefaultAsync(t => t.System == system && t.ExternalId == ticketExternalId, ct);
        if (ticket is null)
        {
            return new TicketConversationResult(false, 0, 0, 0);
        }

        var now = time.GetUtcNow();
        var stored = (await db.TicketComments.Where(c => c.TicketId == ticket.Id).ToListAsync(ct)).ToDictionary(c => c.ExternalId, StringComparer.Ordinal);
        int added = 0, updated = 0;
        foreach (var source in comments.DistinctBy(c => c.ExternalId, StringComparer.Ordinal))
        {
            if (stored.Remove(source.ExternalId, out var comment))
            {
                updated += comment.Apply(source, withheld, now) ? 1 : 0;
            }
            else
            {
                db.TicketComments.Add(TicketComment.From(ticket.Id, system, source, withheld, now));
                added++;
            }
        }

        db.TicketComments.RemoveRange(stored.Values);
        ticket.ConversationRead(now);
        await db.SaveChangesAsync(ct);
        return new TicketConversationResult(true, added, updated, stored.Count);
    }

    public async Task<IReadOnlyList<TicketRef>> StaleAsync(string system, DateTimeOffset readBefore, int limit, CancellationToken ct) =>
        await db.Tickets.AsNoTracking()
            .Where(t => t.System == system && t.IsOpen && (t.CommentsReadAt == null || t.CommentsReadAt < readBefore))
            .OrderBy(t => t.CommentsReadAt == null ? 0 : 1).ThenBy(t => t.CommentsReadAt).ThenBy(t => t.Id)
            .Take(Math.Clamp(limit, 1, 500))
            .Select(t => new TicketRef(t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.Url))
            .ToListAsync(ct);

    public async Task<TicketView?> GetAsync(string system, long externalId, CancellationToken ct) =>
        await db.Tickets.AsNoTracking().Where(t => t.System == system && t.ExternalId == externalId)
            .Select(t => new TicketView(
                t.Id, t.System, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.IsOpen, t.Priority, t.TechnicianUserId, t.TechnicianName,
                t.EndUserName, t.EndUserEmail, t.OwnerCustomerId, t.Url))
            .SingleOrDefaultAsync(ct);
}
