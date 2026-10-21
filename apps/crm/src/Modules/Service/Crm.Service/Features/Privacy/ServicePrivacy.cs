using System.Globalization;
using Crm.Privacy.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Privacy;

/// <summary>
/// The service module's part in subject requests (DEV-11): tickets mirrored from Atera where the person is the end user, with their
/// conversations (M39.2), and ticket requests made for them. A ticket forgets its end user and its conversation keeps only its
/// shape (Atera keeps the ticket; the next synchronization leaves the person out while they are suppressed); a ticket request
/// loses what was written about the person.
/// </summary>
internal sealed class ServicePersonalData(ServiceDbContext db) : IPersonalDataContributor
{
    public const string TicketClass = "service.ticket-end-user";
    public const string RequestClass = "service.ticket-request";

    public string Module => ServiceDbContext.SchemaName;

    public async Task<PersonalDataSection> ExportAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        var tickets = await Tickets(subject).AsNoTracking().OrderBy(t => t.CreatedAtSource).ToListAsync(cancellationToken);
        var requests = await Requests(subject).AsNoTracking().OrderBy(r => r.CreatedAt).ToListAsync(cancellationToken);
        var items = tickets.Select(t => new PersonalDataItem("ticket", t.Id, new Dictionary<string, string?>
        {
            ["system"] = t.System,
            ["ticket"] = t.ExternalId.ToString(CultureInfo.InvariantCulture),
            ["title"] = t.Title,
            ["status"] = t.Status,
            ["endUserName"] = t.EndUserName,
            ["endUserEmail"] = t.EndUserEmail,
            ["createdAt"] = t.CreatedAtSource.ToString("O", CultureInfo.InvariantCulture),
        })).ToList();
        var ticketIds = tickets.Select(t => t.Id).ToList();
        var comments = await db.TicketComments.AsNoTracking().Where(c => ticketIds.Contains(c.TicketId))
            .OrderBy(c => c.TicketId).ThenBy(c => c.CreatedAtSource).ToListAsync(cancellationToken);
        items.AddRange(comments.Select(c => new PersonalDataItem("ticketComment", c.Id, new Dictionary<string, string?>
        {
            ["ticket"] = tickets.Single(t => t.Id == c.TicketId).ExternalId.ToString(CultureInfo.InvariantCulture),
            ["author"] = c.Author.ToString(),
            ["authorName"] = c.AuthorName,
            ["internal"] = c.IsInternal ? "true" : "false",
            ["text"] = c.Text,
            ["createdAt"] = c.CreatedAtSource.ToString("O", CultureInfo.InvariantCulture),
        })));
        items.AddRange(requests.Select(r => new PersonalDataItem("ticketRequest", r.Id, new Dictionary<string, string?>
        {
            ["title"] = r.Title,
            ["description"] = r.Description,
            ["status"] = r.Status.ToString(),
            ["createdAt"] = r.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
        })));
        return new PersonalDataSection(Module, items, ["Atera keeps the tickets themselves, with their conversation; the CRM mirrors the fields and the comments listed here."]);
    }

    public async Task<IReadOnlyList<PlannedErasure>> PlanAsync(DataSubject subject, CancellationToken cancellationToken)
    {
        var plan = (await Tickets(subject).AsNoTracking().Select(t => t.Id).ToListAsync(cancellationToken))
            .Select(id => new PlannedErasure(new RecordRef(Module, nameof(Ticket), id), ErasureAction.Pseudonymize, TicketClass))
            .ToList();
        plan.AddRange((await Requests(subject).AsNoTracking().Select(r => r.Id).ToListAsync(cancellationToken))
            .Select(id => new PlannedErasure(new RecordRef(Module, nameof(TicketRequest), id), ErasureAction.Pseudonymize, RequestClass)));
        return plan;
    }

    public async Task<IReadOnlyList<ErasedRecord>> EraseAsync(
        DataSubject subject, IReadOnlyList<PlannedErasure> plan, string reference, CancellationToken cancellationToken)
    {
        var due = plan.Where(p => p.Action != ErasureAction.Retain).ToList();
        await ApplyAsync(due.Select(p => p.Record).ToList(), reference, cancellationToken);
        return due.Select(p => new ErasedRecord(p.Record, p.Action, p.DataClass)).ToList();
    }

    public Task<int> ReapplyAsync(IReadOnlyList<ErasedRecord> records, string reference, CancellationToken cancellationToken) =>
        ApplyAsync(records.Select(r => r.Record).ToList(), reference, cancellationToken);

    private async Task<int> ApplyAsync(IReadOnlyList<RecordRef> records, string reference, CancellationToken ct)
    {
        var ticketIds = records.Where(r => r.EntityType == nameof(Ticket)).Select(r => r.EntityId).ToList();
        var requestIds = records.Where(r => r.EntityType == nameof(TicketRequest)).Select(r => r.EntityId).ToList();
        var applied = 0;
        foreach (var ticket in await db.Tickets.Where(t => ticketIds.Contains(t.Id)).ToListAsync(ct))
        {
            applied += ticket.ForgetEndUser() ? 1 : 0;
        }

        // The conversation of the person's tickets is about them: it keeps its shape, not its words or authors (M39.2).
        foreach (var comment in await db.TicketComments.Where(c => ticketIds.Contains(c.TicketId)).ToListAsync(ct))
        {
            applied += comment.Forget() ? 1 : 0;
        }

        foreach (var request in await db.TicketRequests.IgnoreQueryFilters().Where(r => requestIds.Contains(r.Id)).ToListAsync(ct))
        {
            applied += request.Erase(reference) ? 1 : 0;
        }

        await db.SaveChangesAsync(ct);
        return applied;
    }

    private IQueryable<Ticket> Tickets(DataSubject subject)
    {
        var emails = subject.Emails.Select(e => e.Trim().ToLowerInvariant()).ToList();
        // The database compares case-insensitively (default collation), like the addresses Atera sends.
        return subject.Kind == DataSubjectKind.Contact
            ? db.Tickets.Where(t => t.ContactId == subject.Id || (t.EndUserEmail != null && emails.Contains(t.EndUserEmail)))
            : db.Tickets.Where(t => t.EndUserEmail != null && emails.Contains(t.EndUserEmail));
    }

    private IQueryable<TicketRequest> Requests(DataSubject subject) =>
        subject.Kind == DataSubjectKind.Contact ? db.TicketRequests.IgnoreQueryFilters().Where(r => r.ContactId == subject.Id) : db.TicketRequests.Where(_ => false);
}

/// <summary>The ticket mirror (docs/04 §8): closed tickets older than the approved period are removed; Atera keeps the source.</summary>
internal sealed class TicketMirrorRetention(ServiceDbContext db) : IRetentionContributor
{
    public const string Class = "service.tickets";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) => Due(olderThan).CountAsync(cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await Due(olderThan).OrderBy(t => t.Id).Select(t => t.Id).Take(batchSize).ToListAsync(cancellationToken);
        return ids.Count == 0 ? 0 : await db.Tickets.Where(t => ids.Contains(t.Id)).ExecuteDeleteAsync(cancellationToken);
    }

    private IQueryable<Ticket> Due(DateTimeOffset olderThan) =>
        db.Tickets.Where(t => !t.IsOpen && (t.ResolvedAt ?? t.LastActivityAt ?? t.CreatedAtSource) < olderThan);
}
