using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// One message of a ticket's conversation, mirrored from the service desk (M39.2): a reply to or from the customer, or an internal
/// note. Not audited — the desk is the system of record. It belongs to its ticket and goes with it (retention deletes closed
/// tickets, and their conversations with them). Its text and author are personal data of the ticket's end user (DEV-11).
/// </summary>
public sealed class TicketComment : Entity
{
    public const int AuthorNameLength = 256;
    public const string Withheld = "—";

    private TicketComment() { }

    public Guid TicketId { get; private set; }
    public string System { get; private set; } = string.Empty;
    public string ExternalId { get; private set; } = string.Empty;
    public string Text { get; private set; } = string.Empty;
    public bool IsInternal { get; private set; }
    public TicketCommentAuthor Author { get; private set; }
    public string? AuthorName { get; private set; }
    public Guid? TechnicianUserId { get; private set; }
    public DateTimeOffset CreatedAtSource { get; private set; }

    /// <summary>When a read last changed the comment; a read that found it unchanged leaves the time.</summary>
    public DateTimeOffset SyncedAt { get; private set; }

    public static TicketComment From(Guid ticketId, string system, ExternalTicketComment source, bool withheld, DateTimeOffset now)
    {
        var comment = new TicketComment { TicketId = ticketId, System = system, ExternalId = source.ExternalId };
        comment.Apply(source, withheld, now);
        return comment;
    }

    /// <summary>Returns true when what the comment shows changed. A withheld comment keeps neither its text nor its author's name.</summary>
    public bool Apply(ExternalTicketComment source, bool withheld, DateTimeOffset now)
    {
        var before = Signature();
        Text = withheld ? Withheld : source.Text;
        IsInternal = source.IsInternal;
        Author = source.Author;
        AuthorName = withheld || source.AuthorName is null ? null : source.AuthorName.Length > AuthorNameLength ? source.AuthorName[..AuthorNameLength] : source.AuthorName;
        TechnicianUserId = source.TechnicianUserId;
        CreatedAtSource = source.CreatedAt;
        var changed = before != Signature();
        if (changed)
        {
            SyncedAt = now;
        }

        return changed;
    }

    /// <summary>Forgets what the comment says and who wrote it (DEV-11); the comment stays so the conversation keeps its shape.</summary>
    public bool Forget()
    {
        if (Text == Withheld && AuthorName is null)
        {
            return false;
        }

        Text = Withheld;
        AuthorName = null;
        return true;
    }

    private string Signature() => string.Join('|', Text, IsInternal, Author, AuthorName, TechnicianUserId, CreatedAtSource.ToUnixTimeSeconds());
}
