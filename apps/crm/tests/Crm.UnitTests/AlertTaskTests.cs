using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Features;
using Crm.Service.Contracts;

namespace Crm.UnitTests;

/// <summary>
/// M38: an alert made into a task. The request is checked before anything is read, and the fingerprint names exactly what the
/// employee reviewed. Synthetic data only.
/// </summary>
public sealed class AlertTaskTests
{
    private static readonly AlertRef Sample = new(Guid.Parse("0b000000-0000-0000-0000-000000000001"), Guid.Parse("0c000000-0000-0000-0000-000000000001"),
        "atera", AlertKind.Monitoring, "920029", "900029", "Disk almost full (92 %)", AlertSeverity.Critical, AlertState.Open, "SRV-01", null,
        DateTimeOffset.Parse("2026-10-21T06:00:00Z"), null);
    private static readonly string Fingerprint = AlertTaskService.Fingerprint(Sample);
    private static AlertTaskRequest Request() => new(Sample.Id, Guid.NewGuid(), DateTimeOffset.Parse("2026-10-22T14:00:00Z"), "Disk almost full", Fingerprint);

    [Fact]
    public void A_valid_request_passes()
    {
        new AlertTaskRequestValidator().Validate(Request()).IsValid.ShouldBeTrue();
        new AlertTaskRequestValidator().Validate(Request() with { DueAt = null }).IsValid.ShouldBeTrue("a task may have no due date");
    }

    [Theory]
    [InlineData("alert", "AlertId")][InlineData("assignee", "AssigneeId")][InlineData("subject-empty", "Subject")]
    [InlineData("subject-long", "Subject")][InlineData("subject-lines", "Subject")][InlineData("due", "DueAt")]
    [InlineData("fingerprint-missing", "ExpectedFingerprint")][InlineData("fingerprint-upper", "ExpectedFingerprint")]
    [InlineData("fingerprint-short", "ExpectedFingerprint")]
    public void An_invalid_request_names_the_field(string scenario, string field)
    {
        var request = scenario switch
        {
            "alert" => Request() with { AlertId = Guid.Empty }, "assignee" => Request() with { AssigneeId = Guid.Empty },
            "subject-empty" => Request() with { Subject = "  " }, "subject-long" => Request() with { Subject = new string('x', 257) },
            "subject-lines" => Request() with { Subject = "Disk\nfull" }, "due" => Request() with { DueAt = DateTimeOffset.Parse("2200-01-01T00:00:00Z") },
            "fingerprint-missing" => Request() with { ExpectedFingerprint = null! },
            "fingerprint-upper" => Request() with { ExpectedFingerprint = Fingerprint.ToUpperInvariant() },
            _ => Request() with { ExpectedFingerprint = Fingerprint[..63] },
        };
        var result = new AlertTaskRequestValidator().Validate(request);
        result.IsValid.ShouldBeFalse();
        result.Errors.Select(e => e.PropertyName).Distinct().ShouldBe([field]);
    }

    [Fact]
    public void A_request_with_a_field_the_api_does_not_know_is_refused()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var known = $$"""{"alertId":"{{Sample.Id}}","assigneeId":"{{Guid.NewGuid()}}","dueAt":null,"subject":"Disk","expectedFingerprint":"{{Fingerprint}}"}""";
        JsonSerializer.Deserialize<AlertTaskRequest>(known, options).ShouldNotBeNull();
        // A client that sends a priority or a customer of its own must not believe it was used: the alert decides both.
        Should.Throw<JsonException>(() => JsonSerializer.Deserialize<AlertTaskRequest>(known.Replace("}", ""","priority":"High"}"""), options));
        Should.Throw<JsonException>(() => JsonSerializer.Deserialize<AlertTaskLookupRequest>("""{"alertIds":[],"organizationId":null}""", options));
    }

    [Fact]
    public void A_lookup_asks_for_one_page_of_alerts_at_most()
    {
        var validator = new AlertTaskLookupRequestValidator();
        validator.Validate(new AlertTaskLookupRequest([Guid.NewGuid()])).IsValid.ShouldBeTrue();
        validator.Validate(new AlertTaskLookupRequest([.. Enumerable.Range(0, 50).Select(_ => Guid.NewGuid())])).IsValid.ShouldBeTrue();
        validator.Validate(new AlertTaskLookupRequest([])).IsValid.ShouldBeFalse();
        validator.Validate(new AlertTaskLookupRequest(null!)).IsValid.ShouldBeFalse();
        validator.Validate(new AlertTaskLookupRequest([.. Enumerable.Range(0, 51).Select(_ => Guid.NewGuid())])).IsValid.ShouldBeFalse();
        validator.Validate(new AlertTaskLookupRequest([Guid.NewGuid(), Guid.Empty])).IsValid.ShouldBeFalse();
    }

    [Fact]
    public void The_fingerprint_changes_with_what_the_employee_reviewed_and_with_nothing_else()
    {
        Fingerprint.Length.ShouldBe(64);
        Fingerprint.ShouldMatch("^[0-9a-f]{64}$");
        AlertTaskService.Fingerprint(Sample with { }).ShouldBe(Fingerprint);
        foreach (var changed in new[]
        {
            Sample with { Title = "Disk almost full (95 %)" }, Sample with { Severity = AlertSeverity.Warning }, Sample with { State = AlertState.Resolved },
            Sample with { DeviceName = "SRV-02" }, Sample with { OrganizationId = Guid.NewGuid() }, Sample with { ExternalCustomerId = "900030" },
            Sample with { ExternalId = "920030" }, Sample with { CreatedAtSource = Sample.CreatedAtSource.AddHours(1) }, Sample with { Id = Guid.NewGuid() },
        })
            AlertTaskService.Fingerprint(changed).ShouldNotBe(Fingerprint);
        // Acknowledging is not a change of the alert itself, and the link and device match follow configuration and other rows.
        AlertTaskService.Fingerprint(Sample with { State = AlertState.Acknowledged }).ShouldBe(Fingerprint);
        AlertTaskService.Fingerprint(Sample with { Url = "https://atera.example/alerts/920029", DeviceId = Guid.NewGuid() }).ShouldBe(Fingerprint);
    }

    [Fact]
    public void A_critical_alert_makes_a_high_priority_task_and_only_a_resolved_alert_is_closed()
    {
        AlertTaskService.PriorityOf(Sample).ShouldBe(ActivityPriority.High);
        AlertTaskService.PriorityOf(Sample with { Severity = AlertSeverity.Warning }).ShouldBe(ActivityPriority.Normal);
        AlertTaskService.IsOpen(Sample).ShouldBeTrue();
        AlertTaskService.IsOpen(Sample with { State = AlertState.Acknowledged }).ShouldBeTrue();
        AlertTaskService.IsOpen(Sample with { State = AlertState.Resolved }).ShouldBeFalse();
    }

    [Fact]
    public void An_alert_without_its_sources_customer_or_of_another_system_has_no_task_identity()
    {
        AlertTaskService.IdentityOf(Sample).ShouldBe(new SourceTaskIdentity("atera", "alert", "900029", "920029", "Task"));
        AlertTaskService.IdentityOf(Sample with { ExternalCustomerId = null }).ShouldBeNull();
        AlertTaskService.IdentityOf(Sample with { System = "m38-synthetic" }).ShouldBeNull();
        AlertTaskService.IdentityOf(Sample with { ExternalId = "alert id with spaces" }).ShouldBeNull();
    }

    [Fact]
    public async Task Without_both_permissions_nothing_is_read()
    {
        foreach (var user in new[] { new SourceTaskTests.User(null), new SourceTaskTests.User(Guid.NewGuid(), service: false),
            new SourceTaskTests.User(Guid.NewGuid(), read: false) })
        {
            var tasks = new AlertTaskService(null!, null!, null!, null!, user);
            (await tasks.PreviewAsync(Sample.Id, default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
            (await tasks.CreateAsync(Request(), default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
            (await tasks.LookupAsync(new([Sample.Id]), default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
        }

        var reader = new AlertTaskService(null!, null!, null!, null!, new SourceTaskTests.User(Guid.NewGuid(), write: false));
        (await reader.CreateAsync(Request(), default)).Error!.Code.ShouldBe("ACT_SOURCE_TASK_FORBIDDEN");
    }
}
