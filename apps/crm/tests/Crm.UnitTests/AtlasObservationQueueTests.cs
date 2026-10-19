using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Integrations.Core.Parasol;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

public sealed class AtlasObservationQueueTests
{
    private static readonly AtlasCustomerReference Expected = new("synthetic-workspace", "synthetic-client");
    private static readonly AtlasObservationSelection Selection = new(AtlasQueueSeverity.CRITICAL, AtlasQueueStatus.ACTIVE);
    private static JsonNode Context() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-context.v1.example.json")))!;
    private static JsonNode Page(int items = 25, int total = 30, string? cursor = "synthetic_source_cursor")
    {
        var page = Context()["observations"]!.DeepClone();
        var row = page["items"]![0]!.DeepClone();
        page["items"] = new JsonArray(Enumerable.Range(0, items).Select(i => { var r = row.DeepClone(); r["id"] = $"observation-{i:D3}"; return r; }).ToArray());
        page["total"] = total;
        foreach (var severity in AtlasProjectionJson.Severities) page["counts"]![severity] = severity == "CRITICAL" ? total : 0;
        page["truncated"] = cursor is not null; page["nextCursor"] = cursor;
        return page;
    }
    private static AtlasObservationQueuePage Read(JsonNode page, string? previousCursor = null, AtlasObservationSelection? selection = null)
    {
        using var overview = JsonDocument.Parse(Context().ToJsonString());
        using var document = JsonDocument.Parse(page.ToJsonString());
        return AtlasObservationQueueProjection.Read(document.RootElement, Expected, selection ?? Selection,
            AtlasDeviceProjection.Read(overview.RootElement, Expected), previousCursor);
    }

    [Fact]
    public void A_queue_has_a_fixed_page_size_global_counts_and_confirmed_device_associations()
    {
        var page = Read(Page());
        page.Items.Count.ShouldBe(25); page.Total.ShouldBe(30); page.SeverityCounts["CRITICAL"].ShouldBe(30);
        page.Items.All(i => i.DeviceId == "device-one" && i.DeviceStatus == "CONFIRMED").ShouldBeTrue();
        page.NextCursor.ShouldBe("synthetic_source_cursor");
        JsonSerializer.Serialize(page.Items).ShouldNotContain("synthetic-private");
    }

    [Theory]
    [InlineData(5, 30)]
    [InlineData(0, 30)]
    [InlineData(0, 0)]
    public void A_terminal_later_page_does_not_confuse_global_total_with_remaining_items(int items, int total)
    {
        var page = Read(Page(items, total, null), "earlier_source_cursor");
        page.Total.ShouldBe(total); page.Items.Count.ShouldBe(items); page.NextCursor.ShouldBeNull();
    }

    [Theory]
    [InlineData("RESOLVED")]
    [InlineData("SUPPRESSED")]
    [InlineData("ACKNOWLEDGED")]
    public void Explicit_status_selection_accepts_terminal_and_acknowledged_observations(string status)
    {
        var page = Page(1, 1, null); page["items"]![0]!["status"] = status;
        Read(page, selection: new(AtlasQueueSeverity.CRITICAL, Enum.Parse<AtlasQueueStatus>(status))).Items.Single().Status.ShouldBe(status);
    }

    [Theory]
    [InlineData("oversized-page")][InlineData("missing-next")][InlineData("short-next")][InlineData("repeat-next")]
    [InlineData("malformed-next")][InlineData("false-truncation")][InlineData("total-mismatch")][InlineData("wrong-severity-count")]
    [InlineData("wrong-severity-row")][InlineData("wrong-status")][InlineData("weakened-priority")][InlineData("other-client")]
    [InlineData("other-workspace")][InlineData("duplicate-row")][InlineData("bad-date")][InlineData("update-before-created")]
    [InlineData("oversized-summary")][InlineData("negative-count")]
    public void Invalid_or_unselected_rows_and_inconsistent_pages_fail_closed(string scenario)
    {
        var page = Page();
        switch (scenario)
        {
            case "oversized-page": page = Page(26); break;
            case "missing-next": page["nextCursor"] = null; break;
            case "short-next": page = Page(24); break;
            case "repeat-next": break;
            case "malformed-next": page["nextCursor"] = "http://invalid.example"; break;
            case "false-truncation": page["truncated"] = false; break;
            case "total-mismatch": page["total"] = 31; break;
            case "wrong-severity-count": page["counts"]!["HIGH"] = 1; page["counts"]!["CRITICAL"] = 29; break;
            case "wrong-severity-row": page["items"]![0]!["severity"] = "HIGH"; break;
            case "wrong-status": page["items"]![0]!["status"] = "RESOLVED"; break;
            case "weakened-priority": page["items"]![0]!["priority"] = "NORMAL"; break;
            case "other-client": page["items"]![0]!["clientId"] = "other-client"; break;
            case "other-workspace": page["items"]![0]!["workspaceId"] = "other-workspace"; break;
            case "duplicate-row": page["items"]![1]!["id"] = "observation-000"; break;
            case "bad-date": page["items"]![0]!["occurredAt"] = "today"; break;
            case "update-before-created": page["items"]![0]!["updatedAt"] = "2020-01-01T00:00:00Z"; break;
            case "oversized-summary": page["items"]![0]!["summary"] = new string('x', 301); break;
            case "negative-count": page["counts"]!["LOW"] = -1; break;
        }
        Should.Throw<JsonException>(() => Read(page, scenario == "repeat-next" ? "synthetic_source_cursor" : null));
    }

    [Fact]
    public void First_page_terminal_counts_must_be_complete_but_urgent_selection_permits_both_urgent_severities()
    {
        Should.Throw<JsonException>(() => Read(Page(5, 30, null)));
        var page = Page(2, 2, null); page["items"]![0]!["severity"] = "HIGH";
        page["counts"]!["CRITICAL"] = 1; page["counts"]!["HIGH"] = 1;
        Read(page, selection: new(AtlasQueueSeverity.URGENT, AtlasQueueStatus.ACTIVE)).Items.Count.ShouldBe(2);
    }

    [Theory]
    [InlineData("info", "ACTIVE")][InlineData("1", "ACTIVE")][InlineData("ALL", "open")]
    [InlineData("ALL", "5")][InlineData("HIGH,CRITICAL", "ACTIVE")][InlineData("ALL", "OPEN,SUPPRESSED")]
    public void Browser_filter_values_are_exact_enum_names(string severity, string status) => AtlasObservationSelection.Parse(severity, status).ShouldBeNull();

    [Fact]
    public void Cursor_is_opaque_and_bound_to_employee_customer_link_workspace_client_filters_and_expiry()
    {
        var time = new ManualTime();
        var service = new AtlasObservationCursor(new EphemeralDataProtectionProvider(), time);
        var employee = Guid.NewGuid(); var identity = new CustomerIdentityView(Guid.NewGuid(), Expected, Guid.NewGuid());
        var cursor = service.Protect(employee, identity, Selection, "synthetic_source_cursor");
        cursor.Length.ShouldBeLessThanOrEqualTo(2048); cursor.ShouldNotContain("synthetic_source_cursor");
        service.TryRead(cursor, employee, identity, Selection, out var source).ShouldBeTrue(); source.ShouldBe("synthetic_source_cursor");
        foreach (var changed in new[] { identity with { CustomerId = Guid.NewGuid() }, identity with { LinkId = Guid.NewGuid() },
            identity with { Atlas = Expected with { WorkspaceId = "other" } }, identity with { Atlas = Expected with { ClientId = "other" } } })
            service.TryRead(cursor, employee, changed, Selection, out _).ShouldBeFalse();
        service.TryRead(cursor, Guid.NewGuid(), identity, Selection, out _).ShouldBeFalse();
        service.TryRead(cursor, employee, identity, new(AtlasQueueSeverity.ALL, AtlasQueueStatus.ACTIVE), out _).ShouldBeFalse();
        service.TryRead(cursor, employee, identity, new(AtlasQueueSeverity.CRITICAL, AtlasQueueStatus.RESOLVED), out _).ShouldBeFalse();
        service.TryRead(cursor[..^5] + "abcde", employee, identity, Selection, out _).ShouldBeFalse();
        service.TryRead(new string('x', 2049), employee, identity, Selection, out _).ShouldBeFalse();
        time.Now += TimeSpan.FromMinutes(15);
        service.TryRead(cursor, employee, identity, Selection, out _).ShouldBeFalse();
    }

    [Fact]
    public void Only_a_trusted_current_continuation_can_report_a_changed_parent_identity()
    {
        var time = new ManualTime(); var service = new AtlasObservationCursor(new EphemeralDataProtectionProvider(), time);
        var employee = Guid.NewGuid(); var identity = new CustomerIdentityView(Guid.NewGuid(), Expected, Guid.NewGuid());
        var cursor = service.Protect(employee, identity, Selection, "synthetic_source_cursor");
        foreach (var changed in new[] { identity with { LinkId = Guid.NewGuid() }, identity with { Atlas = Expected with { WorkspaceId = "other" } },
            identity with { Atlas = Expected with { ClientId = "other" } } })
        {
            service.TryRead(cursor, employee, changed, Selection, out var source, out var identityChanged).ShouldBeFalse();
            source.ShouldBeNull(); identityChanged.ShouldBeTrue();
        }
        var replaced = identity with { LinkId = Guid.NewGuid() };
        service.TryRead(cursor, Guid.NewGuid(), replaced, Selection, out _, out var otherEmployee).ShouldBeFalse(); otherEmployee.ShouldBeFalse();
        service.TryRead(cursor, employee, replaced with { CustomerId = Guid.NewGuid() }, Selection, out _, out var otherCustomer).ShouldBeFalse(); otherCustomer.ShouldBeFalse();
        service.TryRead(cursor, employee, replaced, new(AtlasQueueSeverity.ALL, AtlasQueueStatus.ACTIVE), out _, out var otherFilter).ShouldBeFalse(); otherFilter.ShouldBeFalse();
        service.TryRead(cursor[..^5] + "abcde", employee, replaced, Selection, out _, out var tampered).ShouldBeFalse(); tampered.ShouldBeFalse();
        time.Now += TimeSpan.FromMinutes(15);
        service.TryRead(cursor, employee, replaced, Selection, out _, out var expired).ShouldBeFalse(); expired.ShouldBeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("pc:one/&cursor=forged#fragment")]
    public async Task Upstream_query_is_fixed_typed_and_never_forwards_browser_parameters_or_cookies(string? deviceId)
    {
        var factory = new Factory((request, _) =>
        {
            request.RequestUri!.AbsolutePath.ShouldBe("/clients/synthetic-client/observations");
            request.RequestUri.Query.ShouldBe("?limit=25&status=OPEN%2CACKNOWLEDGED&severity=HIGH%2CCRITICAL"
                + (deviceId is null ? "" : $"&deviceId={Uri.EscapeDataString(deviceId)}") + "&cursor=synthetic_source_cursor");
            request.RequestUri.Fragment.ShouldBeEmpty();
            request.Headers.Authorization!.ToString().ShouldBe("Bearer synthetic-personal-token");
            request.Headers.Contains("Cookie").ShouldBeFalse();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("private-error") });
        });
        var client = new AtlasReadClient(Options.Create(new AtlasWorkspaceOptions { BaseUrl = "https://atlas.example.invalid/" }), factory);
        using var result = await client.ObservationsAsync("synthetic-client", new() { Token = "synthetic-personal-token" },
            new(AtlasQueueSeverity.URGENT, AtlasQueueStatus.ACTIVE, deviceId), "synthetic_source_cursor", default);
        result.Status.ShouldBe("INVALID_CURSOR"); result.Document.ShouldBeNull(); factory.Calls.ShouldBe(1);
    }

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.Parse("2026-10-16T10:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private sealed class Factory(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : IHttpClientFactory
    {
        public int Calls { get; private set; }
        public HttpClient CreateClient(string name) => new(new Handler((request, ct) => { Calls++; return send(request, ct); }));
    }
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request, cancellationToken);
    }
}
