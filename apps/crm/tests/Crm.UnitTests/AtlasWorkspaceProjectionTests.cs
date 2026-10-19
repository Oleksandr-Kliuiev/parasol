using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Integrations.Core.Parasol;

namespace Crm.UnitTests;

public sealed class AtlasWorkspaceProjectionTests
{
    private static readonly AtlasCustomerReference Expected = new("synthetic-workspace", "synthetic-client");
    private static JsonNode Context() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-context.v1.example.json")))!;
    private static AtlasWorkspaceSummary Read(JsonNode node)
    {
        using var doc = JsonDocument.Parse(node.ToJsonString());
        return AtlasWorkspaceProjection.Read(doc.RootElement, Expected);
    }

    [Fact]
    public void Projects_technical_fields_and_keeps_people_source_payloads_and_credentials_out()
    {
        var view = Read(Context());
        view.KnownDevices.ShouldBe(2); view.KnownPeople.ShouldBe(1); view.ActiveObservations.ShouldBe(3);
        view.Devices[0].Sources.ShouldBe(["atera", "huntress"]); view.Devices[1].Sources.ShouldBeEmpty();
        view.ObservationPage.Items[0].DeviceId.ShouldBe("device-one");
        view.ObservationPage.Items[0].Priority.ShouldBe("URGENT");
        view.ObservationPage.Items[0].Route.ShouldBe("MONITOR");
        view.ObservationPage.Items[1].DeviceStatus.ShouldBe("UNRESOLVED");
        view.ObservationPage.Items[2].DeviceStatus.ShouldBe("UNAVAILABLE");
        var json = JsonSerializer.Serialize(view);
        foreach (var excluded in new[] { "synthetic-private", "connectionId", "externalEventId", "personId", "confidence", "reasonCodes", "nextCursor" })
            json.ShouldNotContain(excluded, Case.Insensitive);
    }

    [Fact]
    public void A_matching_hostname_or_a_link_to_a_different_source_never_establishes_device_identity()
    {
        var ctx = Context();
        ctx["links"]![0]!["system"] = "huntress";
        var view = Read(ctx);
        view.Devices[0].Hostname.ShouldBe(view.Devices[1].Hostname);
        view.ObservationPage.Items[0].DeviceStatus.ShouldBe("UNAVAILABLE");
        view.ObservationPage.Items[0].DeviceId.ShouldBeNull();
        view.ObservationPage.Items[2].DeviceId.ShouldBeNull();
    }

    [Fact]
    public void Sorting_keeps_an_old_critical_observation_ahead_of_newer_medium_observations()
    {
        var ctx = Context();
        var items = (JsonArray)ctx["observations"]!["items"]!;
        var critical = items[0]!.DeepClone(); items.RemoveAt(0); items.Add(critical);
        var view = Read(ctx);
        view.ObservationPage.Items.Select(o => o.Severity).ShouldBe(["CRITICAL", "HIGH", "MEDIUM"]);
    }

    [Fact]
    public void Empty_graph_and_observations_are_distinct_from_missing_source_snapshots()
    {
        var ctx = Context();
        ctx["devices"] = new JsonArray(); ctx["people"] = new JsonArray(); ctx["links"] = new JsonArray();
        ctx["observations"]!["items"] = new JsonArray(); ctx["observations"]!["total"] = 0;
        foreach (var severity in new[] { "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL" }) ctx["observations"]!["counts"]![severity] = 0;
        var view = Read(ctx);
        view.Devices.ShouldBeEmpty(); view.ObservationPage.Items.ShouldBeEmpty(); view.ActiveObservations.ShouldBe(0);
        view.Resources[1].Status.ShouldBe("MISSING");
    }

    [Fact]
    public void A_bounded_page_explicitly_reports_remaining_active_observations_without_returning_a_cursor()
    {
        var ctx = Context();
        ctx["observations"]!["total"] = 4; ctx["observations"]!["counts"]!["CRITICAL"] = 2;
        ctx["observations"]!["truncated"] = true; ctx["observations"]!["nextCursor"] = "synthetic_cursor";
        var view = Read(ctx);
        view.ActiveObservations.ShouldBe(4); view.ObservationPage.Items.Count.ShouldBe(3); view.ObservationPage.Truncated.ShouldBeTrue();
    }

    [Fact]
    public void Multiline_summaries_are_plain_bounded_text_and_missing_summary_text_is_preserved_as_empty()
    {
        var ctx = Context(); ctx["observations"]!["items"]![0]!["summary"] = "Synthetic\nsecond line\ttext";
        ctx["observations"]!["items"]![1]!["summary"] = "";
        var view = Read(ctx);
        view.ObservationPage.Items[0].Summary.ShouldContain("\n"); view.ObservationPage.Items[1].Summary.ShouldBeEmpty();
    }

    [Theory]
    [InlineData("device-workspace")][InlineData("device-client")][InlineData("person-client")][InlineData("link-client")]
    [InlineData("observation-client")][InlineData("observation-workspace")][InlineData("duplicate-device")][InlineData("duplicate-entity-kind")]
    [InlineData("duplicate-observation")][InlineData("device-limit")][InlineData("people-limit")][InlineData("link-limit")]
    [InlineData("page-limit")][InlineData("resource-limit")][InlineData("resource-item-limit")][InlineData("hostname-limit")]
    [InlineData("hostname-control")][InlineData("summary-limit")][InlineData("summary-control")][InlineData("candidate-link")]
    [InlineData("unknown-link-kind")][InlineData("wrong-link-kind")][InlineData("unknown-source")][InlineData("unknown-severity")]
    [InlineData("weakened-priority")][InlineData("wrong-domain")][InlineData("resolved-status")][InlineData("unknown-route")]
    [InlineData("bad-date")][InlineData("date-without-zone")][InlineData("null-event-date")][InlineData("update-before-creation")]
    [InlineData("negative-count")][InlineData("count-total-mismatch")][InlineData("count-page-mismatch")][InlineData("false-truncation")]
    [InlineData("missing-cursor")][InlineData("unexpected-cursor")][InlineData("fixture-truncated")][InlineData("fixture-mode-mismatch")]
    public void Rejects_an_invalid_nested_row_or_inconsistent_page_as_a_whole(string scenario)
    {
        var ctx = Context(); var devices = (JsonArray)ctx["devices"]!; var people = (JsonArray)ctx["people"]!;
        var links = (JsonArray)ctx["links"]!; var page = ctx["observations"]!; var items = (JsonArray)page["items"]!;
        switch (scenario)
        {
            case "device-workspace": devices[0]!["workspaceId"] = "other"; break;
            case "device-client": devices[0]!["clientId"] = "other"; break;
            case "person-client": people[0]!["clientId"] = "other"; break;
            case "link-client": links[0]!["clientId"] = "other"; break;
            case "observation-client": items[0]!["clientId"] = "other"; break;
            case "observation-workspace": items[0]!["workspaceId"] = "other"; break;
            case "duplicate-device": devices.Add(devices[0]!.DeepClone()); break;
            case "duplicate-entity-kind": devices[0]!["id"] = "person-one"; break;
            case "duplicate-observation": items[1]!["id"] = "observation-critical"; break;
            case "device-limit": for (var i = 2; i < 1001; i++) devices.Add(devices[0]!.DeepClone()); break;
            case "people-limit": for (var i = 1; i < 1001; i++) people.Add(people[0]!.DeepClone()); break;
            case "link-limit": for (var i = 2; i < 1001; i++) links.Add(links[0]!.DeepClone()); break;
            case "page-limit": for (var i = 3; i < 101; i++) items.Add(items[0]!.DeepClone()); break;
            case "resource-limit": for (var i = 2; i < 101; i++) ((JsonArray)ctx["resources"]!).Add(ctx["resources"]![0]!.DeepClone()); break;
            case "resource-item-limit": for (var i = 1; i < 1001; i++) ((JsonArray)ctx["resources"]![0]!["items"]!).Add(new JsonObject()); break;
            case "hostname-limit": devices[0]!["hostname"] = new string('x', 257); break;
            case "hostname-control": devices[0]!["hostname"] = "test\nname"; break;
            case "summary-limit": items[0]!["summary"] = new string('x', 301); break;
            case "summary-control": items[0]!["summary"] = "test\0text"; break;
            case "candidate-link": links[0]!["status"] = "CANDIDATE"; break;
            case "unknown-link-kind": links[0]!["entityKind"] = "OTHER"; break;
            case "wrong-link-kind": links[0]!["entityKind"] = "PERSON"; break;
            case "unknown-source": items[0]!["source"] = "other"; break;
            case "unknown-severity": items[0]!["severity"] = "other"; break;
            case "weakened-priority": items[0]!["priority"] = "NORMAL"; break;
            case "wrong-domain": items[0]!["domain"] = "SECURITY"; break;
            case "resolved-status": items[0]!["status"] = "RESOLVED"; break;
            case "unknown-route": items[0]!["route"] = "OTHER"; break;
            case "bad-date": items[0]!["occurredAt"] = "bad"; break;
            case "date-without-zone": ctx["generatedAt"] = "2026-10-16T10:00:00"; break;
            case "null-event-date": items[0]!["occurredAt"] = null; break;
            case "update-before-creation": items[0]!["updatedAt"] = "2026-10-15T00:00:00Z"; break;
            case "negative-count": page["counts"]!["CRITICAL"] = -1; break;
            case "count-total-mismatch": page["total"] = 99; break;
            case "count-page-mismatch": page["counts"]!["CRITICAL"] = 0; page["counts"]!["MEDIUM"] = 2; break;
            case "false-truncation": page["truncated"] = true; page["nextCursor"] = "synthetic"; break;
            case "missing-cursor": page["total"] = 4; page["counts"]!["CRITICAL"] = 2; page["truncated"] = true; break;
            case "unexpected-cursor": page["nextCursor"] = "synthetic"; break;
            case "fixture-truncated": ctx["mode"] = "fixture"; ctx["completeness"] = "COMPLETE_FIXTURE"; page["total"] = 4;
                page["counts"]!["CRITICAL"] = 2; page["truncated"] = true; page["nextCursor"] = "synthetic"; break;
            case "fixture-mode-mismatch": ctx["mode"] = "fixture"; break;
            default: throw new InvalidOperationException("Missing test scenario");
        }
        var error = Should.Throw<Exception>(() => Read(ctx));
        (error is JsonException or InvalidOperationException or FormatException or KeyNotFoundException).ShouldBeTrue();
    }

    [Theory]
    [InlineData("scope")][InlineData("counts")][InlineData("page")]
    public void Duplicate_JSON_members_cannot_hide_scope_or_count_conflicts(string scenario)
    {
        var json = Context().ToJsonString();
        json = scenario switch
        {
            "scope" => json.Replace("\"id\":\"device-one\"", "\"clientId\":\"other\",\"id\":\"device-one\"", StringComparison.Ordinal),
            "counts" => json.Replace("\"CRITICAL\":1", "\"CRITICAL\":0,\"CRITICAL\":1", StringComparison.Ordinal),
            _ => json.Replace("\"total\":3", "\"total\":0,\"total\":3", StringComparison.Ordinal),
        };
        using var doc = JsonDocument.Parse(json);
        Should.Throw<JsonException>(() => AtlasWorkspaceProjection.Read(doc.RootElement, Expected));
    }
}
