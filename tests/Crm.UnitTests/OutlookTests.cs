using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Integrations.MicrosoftGraph;
using Crm.Notifications.Contracts;

namespace Crm.UnitTests;

public class GraphMappingTests
{
    [Fact]
    public void A_graph_event_keeps_its_activity_id_and_times()
    {
        var activityId = Guid.NewGuid();
        var graphEvent = new GraphEvent(
            "AAMkAG",
            "Oppstartsmøte",
            new GraphDateTime("2026-10-01T09:00:00.0000000", "UTC"),
            new GraphDateTime("2026-10-01T10:30:00.0000000", "UTC"),
            IsCancelled: false,
            "https://outlook.office.com/calendar/item/1",
            [new GraphOpenExtension("no.vardahei.crm", activityId.ToString())]);

        var state = GraphCalendar.Map(graphEvent, GraphCalendar.ActivityIdOf(graphEvent));

        state.ActivityId.ShouldBe(activityId);
        state.StartsAt.ShouldBe(new DateTimeOffset(2026, 10, 1, 9, 0, 0, TimeSpan.Zero));
        state.EndsAt.ShouldBe(new DateTimeOffset(2026, 10, 1, 10, 30, 0, TimeSpan.Zero));
        state.IsCancelled.ShouldBeFalse();
        state.WebLink.ShouldNotBeNull();
    }

    [Fact]
    public void An_event_in_local_time_is_converted_to_utc()
    {
        // Graph answers in the mailbox time zone unless asked otherwise; 11:00 in Oslo is 09:00 UTC in summer.
        var start = GraphCalendar.Parse(new GraphDateTime("2026-07-01T11:00:00.0000000", "W. Europe Standard Time"));

        start.ShouldBe(new DateTimeOffset(2026, 7, 1, 9, 0, 0, TimeSpan.Zero));
    }

    [Fact]
    public void An_event_without_the_extension_belongs_to_nobody_in_the_crm()
    {
        var graphEvent = new GraphEvent("id", "Lunsj", null, null, null, null, null);

        GraphCalendar.ActivityIdOf(graphEvent).ShouldBeNull();
    }

    [Fact]
    public void A_message_keeps_only_metadata()
    {
        var message = new GraphMailMessage(
            "msg-1",
            "<abc@example.no>",
            "Tilbud på drift",
            "Hei, takk for sist. Vi ser på tilbudet.",
            new GraphRecipient(new GraphAddress("kari@kunde.no", "Kari Hansen")),
            [new GraphRecipient(new GraphAddress("ola@vardahei.no", "Ola"))],
            new DateTimeOffset(2026, 9, 20, 8, 15, 0, TimeSpan.Zero),
            HasAttachments: true,
            "https://outlook.office.com/mail/1");

        var mapped = GraphMailbox.Map(message, "me");

        mapped.InternetMessageId.ShouldBe("<abc@example.no>");
        mapped.FromAddress.ShouldBe("kari@kunde.no");
        mapped.ToAddresses.ShouldBe(["ola@vardahei.no"]);
        mapped.HasAttachments.ShouldBeTrue();
        mapped.Mailbox.ShouldBe("me");
    }

    [Theory]
    [InlineData("Åsane Rør & Blikk AS", "912345678", "Åsane Rør & Blikk AS (912345678)")]
    [InlineData("Kunde / Avdeling", null, "Kunde - Avdeling")]
    public void A_customer_folder_is_named_after_the_organization(string name, string? orgNumber, string expected)
    {
        GraphDocuments.FolderName(name, orgNumber).ShouldBe(expected);
    }

    [Fact]
    public void A_teams_card_carries_the_facts_and_one_link()
    {
        var payload = TeamsChannelSender.Payload(new TeamsCard(
            "Salg vunnet 🎉", "Åsane Rør er vunnet.", [new TeamsFact("Kunde", "Åsane Rør")], "https://crm.test/sales/1", "Åpne salget"));

        var json = JsonSerializer.SerializeToElement(payload);
        var content = json.GetProperty("attachments")[0].GetProperty("content");
        content.GetProperty("type").GetString().ShouldBe("AdaptiveCard");
        content.GetProperty("body").EnumerateArray().Count().ShouldBe(3);
        content.GetProperty("actions")[0].GetProperty("url").GetString().ShouldBe("https://crm.test/sales/1");
    }

    [Fact]
    public void A_card_without_a_link_has_no_actions()
    {
        var payload = TeamsChannelSender.Payload(new TeamsCard("Tittel", "Tekst", [], null, null));

        JsonSerializer.SerializeToElement(payload)
            .GetProperty("attachments")[0].GetProperty("content")
            .TryGetProperty("actions", out _).ShouldBeFalse();
    }
}

public class OutlookActivityTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 21, 8, 0, 0, TimeSpan.Zero);

    private static Activity Meeting() => Activity.Create(
        new ActivityDetails(
            ActivityType.Meeting, Guid.NewGuid(), null, null, null, "Oppstartsmøte", "Agenda", Now.AddDays(1),
            ActivityPriority.Normal, Guid.NewGuid(), 90, "Teams"),
        Now).Value;

    [Fact]
    public void A_meeting_remembers_the_event_it_was_pushed_to()
    {
        var meeting = Meeting();

        meeting.LinkCalendarEvent("AAMkAG", "https://outlook.office.com/1", Now);

        meeting.GraphEventId.ShouldBe("AAMkAG");
        meeting.WebLink.ShouldBe("https://outlook.office.com/1");
        meeting.CalendarSyncedAt.ShouldBe(Now);

        meeting.ForgetCalendarEvent();
        meeting.GraphEventId.ShouldBeNull();
    }

    [Fact]
    public void A_meeting_moved_in_outlook_moves_in_the_crm()
    {
        var meeting = Meeting();
        var start = Now.AddDays(2);

        var changed = meeting.ApplyCalendarChange("Oppstart, flyttet", start, start.AddMinutes(45), isCancelled: false, Now);

        changed.ShouldBeTrue();
        meeting.Subject.ShouldBe("Oppstart, flyttet");
        meeting.DueAt.ShouldBe(start);
        meeting.DurationMinutes.ShouldBe(45);
        meeting.Status.ShouldBe(ActivityStatus.Open);

        // Reading the same event again changes nothing.
        meeting.ApplyCalendarChange("Oppstart, flyttet", start, start.AddMinutes(45), false, Now).ShouldBeFalse();
    }

    [Fact]
    public void A_meeting_cancelled_in_outlook_is_cancelled_in_the_crm()
    {
        var meeting = Meeting();

        meeting.ApplyCalendarChange("Oppstartsmøte", Now.AddDays(1), Now.AddDays(1).AddHours(1), isCancelled: true, Now).ShouldBeTrue();

        meeting.Status.ShouldBe(ActivityStatus.Cancelled);
    }

    [Fact]
    public void A_saved_message_is_a_finished_record_and_cannot_be_edited()
    {
        var organizationId = Guid.NewGuid();
        var mail = Activity.FromMail(
            new SavedMailDetails(
                organizationId, null, null, null, "Tilbud på drift", "Hei, takk for sist.", "kari@kunde.no", "Kari",
                Now.AddHours(-2), "<abc@example.no>", "https://outlook.office.com/mail/1"),
            Guid.NewGuid(),
            Now);

        mail.Type.ShouldBe(ActivityType.Email);
        mail.Status.ShouldBe(ActivityStatus.Done);
        mail.CompletedAt.ShouldBe(Now.AddHours(-2));
        mail.ExternalMessageId.ShouldBe("<abc@example.no>");
        mail.FromAddress.ShouldBe("kari@kunde.no");

        var edited = mail.Update(
            new ActivityDetails(ActivityType.Email, organizationId, null, null, null, "Endret", null, null, ActivityPriority.Normal, null),
            Now);

        edited.IsSuccess.ShouldBeFalse();
        edited.Error!.Code.ShouldBe("ACT_MAIL_READONLY");
    }

    [Fact]
    public void A_meeting_keeps_its_length_and_place()
    {
        var meeting = Meeting();

        meeting.DurationMinutes.ShouldBe(90);
        meeting.Location.ShouldBe("Teams");
    }
}
