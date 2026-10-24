using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Service.Contracts;
using Crm.Service.Domain;

namespace Crm.UnitTests;

/// <summary>M39.2: reading a ticket's conversation from Atera's JSON, and what the mirror keeps of a comment.</summary>
public class AteraConversationTests
{
    private static AteraComment? Read(string json) => AteraClient.ReadComment(JsonDocument.Parse(json).RootElement, 42);

    [Fact]
    public void A_flat_technician_comment_reads_with_its_author_and_time()
    {
        var comment = Read("""{"CommentID":7,"CommentText":"Vi ser på det","CommentDate":"2026-10-21T08:00:00Z","IsInternal":false,"TechnicianContactID":4001,"TechnicianFullName":"Tor Tekniker","TechnicianEmail":"tor@example.no"}""")!;
        comment.ShouldBe(new AteraComment("7", 42, "Vi ser på det", false, AteraCommentAuthor.Technician, "4001", "Tor Tekniker", "tor@example.no",
            DateTimeOffset.Parse("2026-10-21T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture)));
    }

    [Fact]
    public void A_comment_in_the_posted_shape_and_an_end_users_message_read_too()
    {
        var nested = Read("""{"CommentId":"c-1","CommentText":"Notat","CommentTimestampUTC":"2026-10-21T08:00:00Z","TechnicianCommentDetails":{"TechnicianId":4002,"IsInternal":true}}""")!;
        (nested.Author, nested.AuthorExternalId, nested.IsInternal).ShouldBe((AteraCommentAuthor.Technician, "4002", true));

        var customer = Read("""{"CommentID":8,"CommentText":"Takk","CommentDate":"2026-10-21T09:00:00Z","EnduserID":55,"FirstName":"Kari","LastName":"Kunde","Email":"kari@example.no"}""")!;
        (customer.Author, customer.AuthorExternalId, customer.AuthorName, customer.IsInternal).ShouldBe((AteraCommentAuthor.EndUser, "55", "Kari Kunde", false));
    }

    [Fact]
    public void Only_technicians_write_internal_notes_so_an_anonymous_internal_comment_is_a_technicians() =>
        Read("""{"CommentID":9,"CommentText":"x","CommentDate":"2026-10-21T09:00:00Z","IsInternal":true}""")!.Author.ShouldBe(AteraCommentAuthor.Technician);

    [Theory]
    [InlineData("""{"CommentText":"no id","CommentDate":"2026-10-21T09:00:00Z"}""")]
    [InlineData("""{"CommentID":10,"CommentText":"no time"}""")]
    public void A_comment_without_an_id_or_a_time_is_not_read(string json) => Read(json).ShouldBeNull();

    [Fact]
    public void A_withheld_comment_keeps_its_shape_but_not_its_words_or_author()
    {
        var source = new ExternalTicketComment("c-1", "Kari's laptop is broken", false, TicketCommentAuthor.EndUser, "Kari Kunde", null, DateTimeOffset.UnixEpoch);
        var kept = TicketComment.From(Guid.NewGuid(), "atera", source, withheld: true, DateTimeOffset.UnixEpoch);
        (kept.Text, kept.AuthorName, kept.Author).ShouldBe((TicketComment.Withheld, (string?)null, TicketCommentAuthor.EndUser));

        var open = TicketComment.From(Guid.NewGuid(), "atera", source, withheld: false, DateTimeOffset.UnixEpoch);
        open.Apply(source, false, DateTimeOffset.UnixEpoch.AddDays(1)).ShouldBeFalse("the same comment read again is no change");
        open.Forget().ShouldBeTrue();
        (open.Text, open.AuthorName).ShouldBe((TicketComment.Withheld, (string?)null));
        open.Forget().ShouldBeFalse();
    }
}
