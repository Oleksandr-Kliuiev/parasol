using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Integrations.Core.Parasol;

namespace Crm.UnitTests;

public sealed class AtlasM365ProjectionTests
{
    private static JsonNode Input() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-overview.v1.example.json")))!;
    private static AtlasM365Summary Read(JsonNode input)
    {
        using var json = JsonDocument.Parse(input.ToJsonString());
        return AtlasM365Projection.Read(json.RootElement, new("synthetic-workspace", "synthetic-client"));
    }

    [Fact]
    public void Projects_only_scoped_counts_and_freshness_with_an_explicit_coverage_window()
    {
        var result = Read(Input()); result.TotalConnections.ShouldBe(1); result.Truncated.ShouldBeFalse();
        result.Connections[0].Directory.Select(d => d.Count).ShouldBe([14, 10]);
        result.Connections[0].Directory[1].Status.ShouldBe("STALE"); result.Connections[0].SignIns.Coverage.ShouldBe("PARTIAL");
        result.Connections[0].SignIns.Gaps.Count.ShouldBe(2); (result.WindowTo - result.WindowFrom).ShouldBe(TimeSpan.FromHours(24));
        var body = JsonSerializer.Serialize(result);
        foreach (var excluded in new[] { "workspaceId", "clientId", "tenantId", "displayName", "userPrincipalName", "dto", "secretRef" }) body.ShouldNotContain(excluded);
    }

    [Theory]
    [InlineData("workspaceId")]
    [InlineData("clientId")]
    public void Rejects_another_scope(string field)
    {
        var input = Input(); input[field] = "foreign";
        Should.Throw<JsonException>(() => Read(input));
    }

    [Theory]
    [InlineData("count-overflow")]
    [InlineData("count-missing")]
    [InlineData("expired-count")]
    [InlineData("duplicate-resource")]
    [InlineData("duplicate-connection")]
    [InlineData("private-field")]
    [InlineData("unknown-version")]
    [InlineData("too-many")]
    [InlineData("inconsistent-total")]
    [InlineData("fake-partial")]
    [InlineData("future-date")]
    [InlineData("local-time")]
    [InlineData("wrong-window")]
    [InlineData("unaligned-window")]
    [InlineData("overlapping-gaps")]
    [InlineData("outside-gap")]
    [InlineData("complete-with-gap")]
    [InlineData("unavailable-with-counted-coverage")]
    [InlineData("unknown-freshness")]
    public void Rejects_invalid_or_misleading_metadata_instead_of_truncating_a_success(string change)
    {
        var input = Input(); var connection = input["connections"]![0]!; var directory = connection["directory"]!; var signIns = connection["signIns"]!;
        switch (change)
        {
            case "count-overflow": directory[0]!["count"] = 20_001; break;
            case "count-missing": directory[0]!["count"] = null; break;
            case "expired-count": directory[0]!["status"] = "MISSING"; break;
            case "duplicate-resource": directory[1]!["resourceType"] = "m365_user"; break;
            case "duplicate-connection": input["connections"]!.AsArray().Add(connection.DeepClone()); input["totalConnections"] = 2; break;
            case "private-field": connection["userPrincipalName"] = "synthetic-private@example.invalid"; break;
            case "unknown-version": input["contractVersion"] = "future"; break;
            case "too-many": for (var i = 1; i < 9; i++) input["connections"]!.AsArray().Add(connection.DeepClone()); input["totalConnections"] = 9; break;
            case "inconsistent-total": input["totalConnections"] = 2; break;
            case "fake-partial": input["truncated"] = true; break;
            case "future-date": directory[0]!["asOf"] = "2030-01-01T12:00:00Z"; break;
            case "local-time": input["assessedAt"] = "2026-10-17T14:15:00+02:00"; break;
            case "wrong-window": input["window"]!["fromInclusive"] = "2026-10-16T11:00:00Z"; break;
            case "unaligned-window": input["window"]!["fromInclusive"] = "2026-10-16T12:01:00Z"; input["window"]!["toExclusive"] = "2026-10-17T12:01:00Z"; break;
            case "overlapping-gaps": signIns["gaps"]![1]!["fromInclusive"] = "2026-10-16T12:30:00Z"; break;
            case "outside-gap": signIns["gaps"]![0]!["fromInclusive"] = "2026-10-16T11:59:00Z"; break;
            case "complete-with-gap": signIns["coverage"] = "COMPLETE"; break;
            case "unavailable-with-counted-coverage": signIns["coverage"] = "UNAVAILABLE"; break;
            case "unknown-freshness": signIns["freshness"] = "UNKNOWN"; break;
        }
        Should.Throw<JsonException>(() => Read(input));
    }

    [Fact]
    public void Empty_fresh_data_and_missing_data_remain_distinct_and_zero_active_connections_is_supported()
    {
        var input = Input(); var directory = input["connections"]![0]!["directory"]!;
        directory[0]!["count"] = 0;
        directory[1]!["status"] = "MISSING"; directory[1]!["count"] = null; directory[1]!["asOf"] = null;
        Read(input).Connections[0].Directory.Select(d => d.Count).ShouldBe([0, null]);
        input["connections"] = new JsonArray(); input["totalConnections"] = 0;
        Read(input).Connections.ShouldBeEmpty();
    }

    [Fact]
    public void Duplicate_JSON_fields_are_rejected_even_when_the_values_match()
    {
        var raw = Input().ToJsonString().Replace("\"mode\":\"db\"", "\"mode\":\"db\",\"mode\":\"db\"", StringComparison.Ordinal);
        using var doc = JsonDocument.Parse(raw);
        Should.Throw<JsonException>(() => AtlasM365Projection.Read(doc.RootElement, new("synthetic-workspace", "synthetic-client")));
    }
}
