using Crm.Security.Contracts;
using Crm.Security.Domain;
using Crm.Security.Features;

namespace Crm.UnitTests;

/// <summary>
/// M41: the security module mirrors Huntress's incidents, plans, comments and notices as read. A read time alone is no change; a plan
/// and a conversation follow the source step by step; detail that does not fit is left out whole rather than cut into something else;
/// entities not read this time stay as stored; a record the source no longer knows stays as history, closed. Synthetic data only.
/// </summary>
public sealed class SecurityMirrorDomainTests
{
    private static readonly DateTimeOffset First = DateTimeOffset.Parse("2026-10-22T06:00:00Z");
    private static readonly Guid Customer = Guid.Parse("45454545-0000-0000-0000-000000000001");

    [Fact]
    public void An_incident_follows_its_report_and_a_read_time_alone_is_no_change()
    {
        var incident = Incident.From(Report(), First);
        (incident.System, incident.ExternalId, incident.OrganizationId, incident.ExternalOrganizationId, incident.AgentExternalId, incident.DeviceName)
            .ShouldBe(("huntress", 4430L, Customer, 4410L, "4420", "SRV-01"));
        (incident.Status, incident.Severity, incident.IsOpen, incident.FirstReadAt, incident.ReadAt).ShouldBe(("sent", "high", true, First, First));
        (incident.IndicatorTypes, incident.IndicatorCounts).ShouldBe(("footholds,process_detections", """{"footholds":1,"process_detections":2}"""),
            "the counts in name order, so the same counts are never a change");

        incident.Apply(Report(), First.AddMinutes(5)).ShouldBeFalse();
        incident.ReadAt.ShouldBe(First.AddMinutes(5));
        incident.Apply(Report() with { Summary = "The SOC added detail." }, First.AddMinutes(10)).ShouldBeTrue();
        incident.Apply(Report() with { Summary = "The SOC added detail.", IndicatorCounts = new Dictionary<string, int> { ["process_detections"] = 2, ["footholds"] = 1 } },
            First.AddMinutes(15)).ShouldBeFalse("the same counts in another order");
        incident.Apply(Report() with { Summary = "The SOC added detail.", Status = "closed", ClosedAt = First.AddHours(1) }, First.AddHours(1)).ShouldBeTrue();
        incident.IsOpen.ShouldBeFalse();
    }

    [Fact]
    public void Long_texts_are_cut_to_their_columns_and_a_link_that_does_not_fit_is_left_out()
    {
        var incident = Incident.From(Report() with
        {
            Subject = new string('s', 600), Summary = new string('m', 5000), Body = new string('b', 20000),
            Url = "https://huntress.example.invalid/" + new string('u', 600), IndicatorCounts = new Dictionary<string, int>(),
        }, First);

        (incident.Subject.Length, incident.Summary!.Length, incident.Body!.Length, incident.Url, incident.IndicatorCounts)
            .ShouldBe((Incident.SubjectLength, Incident.SummaryLength, Incident.BodyLength, (string?)null, (string?)null));
    }

    [Fact]
    public void A_plan_follows_the_source_step_by_step()
    {
        var incident = Incident.From(Report(), First);
        incident.ApplyRemediations([Step(1, "unapproved"), Step(2, "unapproved", type: "assisted")], First).ShouldBeTrue();
        (incident.Remediations.Count, incident.RemediationsReadAt).ShouldBe((2, (DateTimeOffset?)First));
        incident.Remediations.ShouldAllBe(r => r.IncidentId == incident.Id);

        incident.ApplyRemediations([Step(1, "unapproved"), Step(2, "unapproved", type: "assisted")], First.AddMinutes(5)).ShouldBeFalse();
        incident.RemediationsReadAt.ShouldBe(First.AddMinutes(5), "read again, though nothing changed");

        incident.ApplyRemediations([Step(1, "completed"), Step(2, "approved", type: "assisted")], First.AddMinutes(10)).ShouldBeTrue();
        incident.Remediations.Select(r => (r.ExternalId, r.Status)).ShouldBe([(1L, "completed"), (2L, "approved")], ignoreOrder: true);

        incident.ApplyRemediations([Step(2, "approved", type: "assisted"), Step(3, "unapproved")], First.AddMinutes(15)).ShouldBeTrue();
        incident.Remediations.Select(r => r.ExternalId).ShouldBe([2L, 3L], ignoreOrder: true, "a step the source no longer lists goes");

        incident.ToView().Remediations.Select(r => r.ExternalId).ShouldBe([2L, 3L], "a view lists the plan in the source's order of ids");
    }

    [Fact]
    public void A_step_s_detail_that_does_not_fit_is_left_out_rather_than_cut()
    {
        var incident = Incident.From(Report(), First);
        incident.ApplyRemediations([Step(1, "unapproved") with { Parameters = new string('p', Remediation.ParametersLength + 1) }], First);
        incident.Remediations.ShouldHaveSingleItem().Parameters.ShouldBeNull();

        incident.ApplyRemediations([Step(1, "unapproved") with { Parameters = """[{"name":"path","description":"c:\\temp\\x.exe"}]""" }], First.AddMinutes(1))
            .ShouldBeTrue();
        incident.Remediations.Single().Parameters.ShouldBe("""[{"name":"path","description":"c:\\temp\\x.exe"}]""");
    }

    [Fact]
    public void Comments_follow_the_source_and_a_comment_deleted_there_goes_here()
    {
        var incident = Incident.From(Report(), First);
        incident.ApplyComments([Comment(1, "We rebuilt the host."), Comment(2, "Noted")], First).ShouldBeTrue();
        incident.CommentsReadAt.ShouldBe(First);
        incident.ApplyComments([Comment(1, "We rebuilt the host."), Comment(2, "Noted")], First.AddMinutes(1)).ShouldBeFalse();
        incident.ApplyComments([Comment(1, "We rebuilt the host twice.")], First.AddMinutes(2)).ShouldBeTrue();

        var comment = incident.Comments.ShouldHaveSingleItem();
        (comment.ExternalId, comment.Body, comment.Author, comment.IncidentId).ShouldBe((1L, "We rebuilt the host twice.", "Tor Tekniker", incident.Id));
        incident.ApplyComments([Comment(1, new string('c', 5000))], First.AddMinutes(3));
        incident.Comments.Single().Body.Length.ShouldBe(IncidentComment.BodyLength);
    }

    [Fact]
    public void An_incident_the_source_no_longer_knows_stays_as_history_closed()
    {
        var incident = Incident.From(Report(), First);
        incident.Gone(First.AddDays(1)).ShouldBeTrue();
        (incident.Status, incident.IsOpen, incident.ClosedAt, incident.ReadAt)
            .ShouldBe((Incident.Deleted, false, (DateTimeOffset?)First.AddDays(1), First.AddDays(1)));
        incident.Gone(First.AddDays(2)).ShouldBeFalse("closed once");

        var closed = Incident.From(Report() with { Status = "closed", ClosedAt = First }, First);
        closed.Gone(First.AddDays(1)).ShouldBeTrue();
        closed.ClosedAt.ShouldBe(First, "the time the source closed it stays");
    }

    [Theory]
    [InlineData("sent", true)]
    [InlineData("auto_remediating", true)]
    [InlineData("draft", true)]
    [InlineData("closed", false)]
    [InlineData("dismissed", false)]
    [InlineData("deleted", false)]
    public void An_incident_is_open_while_someone_still_has_it(string status, bool open) =>
        Incident.From(Report() with { Status = status }, First).IsOpen.ShouldBe(open);

    [Fact]
    public void A_notice_keeps_the_entities_it_did_not_read_this_time()
    {
        var notice = Notice.From(Escalation([new NoticeEntity("Agent", "4420", "SRV-01"), new NoticeEntity("Identity", "id-1", "Kari Test")]), First);
        (notice.Kind, notice.ExternalOrganizationIds, notice.IsOpen, notice.AllEntities, notice.EntitiesReadAt)
            .ShouldBe((NoticeKind.Escalation, "4410,4411", true, true, (DateTimeOffset?)First));
        notice.ReadEntities().ShouldBe([new NoticeEntity("Agent", "4420", "SRV-01"), new NoticeEntity("Identity", "id-1", "Kari Test")]);

        notice.Apply(Escalation(null), First.AddMinutes(5)).ShouldBeFalse("a list item names no entities, and nothing else changed");
        (notice.ReadEntities().Count, notice.EntitiesReadAt, notice.ReadAt).ShouldBe((2, (DateTimeOffset?)First, First.AddMinutes(5)));

        notice.Apply(Escalation([]), First.AddMinutes(10)).ShouldBeTrue("read again by id: it is about nothing now");
        notice.ReadEntities().ShouldBeEmpty();
        notice.ToView().ExternalOrganizationId.ShouldBe(4410, "the first organization it names");
    }

    [Fact]
    public void Entities_that_do_not_fit_are_kept_whole_as_far_as_they_go()
    {
        var many = Enumerable.Range(1, 3).Select(i => new NoticeEntity("Identity", $"id-{i}", new string((char)('a' + i), 1500))).ToList();
        var notice = Notice.From(Escalation(many), First);

        notice.Entities!.Length.ShouldBeLessThanOrEqualTo(Notice.EntitiesLength);
        notice.ReadEntities().Select(e => e.Id).ShouldBe(["id-1", "id-2"], "an entity is never cut in two");
        notice.AllEntities.ShouldBeFalse("not all of them were kept");

        var told = Notice.From(Escalation([new NoticeEntity("Agent", "1", "PC-1")], allEntities: false), First);
        told.AllEntities.ShouldBeFalse("the source said it had more");
    }

    [Fact]
    public void A_notice_the_source_no_longer_knows_stays_as_history_resolved()
    {
        var notice = Notice.From(Escalation(null), First);
        notice.Gone(First.AddHours(1)).ShouldBeTrue();
        (notice.Status, notice.IsOpen, notice.ResolvedAtSource).ShouldBe(("resolved", false, (DateTimeOffset?)First.AddHours(1)));
        notice.Gone(First.AddHours(2)).ShouldBeFalse();
        (notice.EntitiesReadAt, notice.ReadEntities().Count).ShouldBe(((DateTimeOffset?)null, 0), "a notice never read by id has no entities");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_step_without_detail_has_no_lines(string? parameters) =>
        SecurityQueries.Details(parameters).ShouldBeEmpty();

    [Fact]
    public void A_step_s_detail_is_shown_as_huntress_wrote_it()
    {
        SecurityQueries.Details("""[{"name":"path","description":"c:\\windows\\tasks\\x"},{"key":"user","value":"ola"},"PC-17",""]""")
            .ShouldBe([new RemediationDetailItem("path", "c:\\windows\\tasks\\x"), new RemediationDetailItem("user", "ola"), new RemediationDetailItem(null, "PC-17")],
                "a list of {name, description}, a key and value, a bare text; an empty one is no line");
        SecurityQueries.Details("Isolate host PC-17").ShouldBe([new RemediationDetailItem(null, "Isolate host PC-17")], "plain text as written");
        SecurityQueries.Details("\"PC-17\"").ShouldBe([new RemediationDetailItem(null, "PC-17")], "a JSON string is its text");
        SecurityQueries.Details("42").ShouldBe([new RemediationDetailItem(null, "42")]);
        SecurityQueries.Details("[{").ShouldBe([new RemediationDetailItem(null, "[{")], "what cannot be read is shown as it is");
        SecurityQueries.Details("""[{"name":"hash"}]""").ShouldBe([new RemediationDetailItem("hash", """{"name":"hash"}""")],
            "an entry without a value shows itself whole");
    }

    private static ExternalIncident Report() => new(
        "huntress", 4430, Customer, 4410, "4420", "SRV-01", "sent", "high", "HIGH - Incident on SRV-01 (Fjord IT AS)", "Synthetic summary", "<Content>",
        "windows", ["footholds", "process_detections"], new Dictionary<string, int> { ["process_detections"] = 2, ["footholds"] = 1 },
        First.AddHours(-1), null, First.AddHours(-1), First.AddMinutes(-30), null);

    private static ExternalRemediation Step(long id, string status, string type = "manual") =>
        new(id, type, $"Step {id}", null, status, null, null, status == "completed" ? First : null);

    private static ExternalIncidentComment Comment(long id, string body) => new(id, body, "Tor Tekniker", First.AddMinutes(id), null);

    private static ExternalNotice Escalation(IReadOnlyList<NoticeEntity>? entities, bool allEntities = true) => new(
        "huntress", NoticeKind.Escalation, 4470, Customer, [4410, 4411], "open", "critical", "Unexpected login from US", "Unexpected Country Access",
        "unexpected_country_access", "US", entities, allEntities, First.AddDays(-1), null, First.AddHours(-1), null);
}
