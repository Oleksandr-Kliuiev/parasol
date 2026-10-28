using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using Crm.Service.Contracts;
using Crm.Service.Features.Coverage;
using Crm.Service.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M40 on SQL Server: the CRM's own coverage rule after a complete read of Atera's agents. An agent silent longer than the limit
/// becomes a gap alert of the CRM (a server's critical), listed and counted like any alert and made into a task like one, and it
/// closes after two clean checks in a row. Only the customers the read covered are checked. The limit and the switch are one
/// setting for the whole CRM, changed with the ETag a person read; the test that changes it puts it back. The gap tests check the
/// rule under a code of their own: a check of the real rule another test runs for its customers counts a clean check of every
/// open gap it does not find, as the nightly read does for a customer that lost its link.
/// </summary>
public sealed class CoverageGapSqlTests(CrmWebFactory factory)
{
    private const string Alerts = "/api/v1/service/alerts";
    private const string Rules = "/api/v1/service/coverage/rules";
    private const string Silent = "atera.agent-silent";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_silent_agent_is_a_gap_of_the_crm_until_two_clean_checks_in_a_row_close_it()
    {
        var (organizationId, marker) = await CustomerAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var now = DateTimeOffset.UtcNow;
        var rule = $"test.{marker}";
        await DevicesAsync(organizationId,
            Agent($"{marker}-srv", $"{marker}-SRV", DeviceType.Server, now.AddDays(-10)),
            Agent($"{marker}-pc", $"{marker}-PC", DeviceType.Workstation, now.AddHours(-2)),
            Agent($"{marker}-new", $"{marker}-NEW", DeviceType.Workstation, null));

        (await CheckAsync(rule, [organizationId])).ShouldBe(new CoverageCheckResult(1, 1, 1, 0, 0), "only the server has been silent past the limit");
        var gap = (await OpenAsync(admin, organizationId)).ShouldHaveSingleItem();
        (gap.GetProperty("system").GetString(), gap.GetProperty("rule").GetString(), gap.GetProperty("kind").GetString(), gap.GetProperty("severity").GetString())
            .ShouldBe((CoverageGaps.System, rule, "Monitoring", "Critical"));
        gap.GetProperty("facts").GetProperty("device").GetString().ShouldBe($"{marker}-SRV");
        gap.GetProperty("title").GetString().ShouldStartWith($"The Atera agent on {marker}-SRV has not reported since ");
        // Dated by its cause, not by the check: silent for 10 days, the 7-day limit passed 3 days ago.
        gap.GetProperty("createdAt").GetDateTimeOffset().ShouldBe(now.AddDays(-3), TimeSpan.FromSeconds(1));
        gap.GetProperty("deviceId").GetGuid().ShouldNotBe(Guid.Empty);
        gap.GetProperty("machineId").GetGuid().ShouldNotBe(Guid.Empty, "the panel leads to the device's card");
        var summary = await (await admin.GetAsync($"/api/v1/service/organizations/{organizationId}/summary", Ct)).ReadJsonAsync();
        summary.GetProperty("criticalAlerts").GetInt32().ShouldBe(1, "a gap alarms like any alert");

        // A gap becomes a task like any alert, and the task's source names the rule and its facts.
        using (var preview = await admin.GetAsync($"/api/v1/activities/source-tasks/preview?alertId={gap.GetProperty("id").GetGuid()}", Ct))
        {
            preview.StatusCode.ShouldBe(HttpStatusCode.OK, await preview.Content.ReadAsStringAsync(Ct));
            var source = (await preview.ReadJsonAsync()).GetProperty("alert");
            (source.GetProperty("rule").GetString(), source.GetProperty("facts").GetProperty("device").GetString()).ShouldBe((rule, $"{marker}-SRV"));
        }

        // The agent reports again: one clean check keeps the gap open, the second closes it.
        await DevicesAsync(organizationId,
            Agent($"{marker}-srv", $"{marker}-SRV", DeviceType.Server, now),
            Agent($"{marker}-pc", $"{marker}-PC", DeviceType.Workstation, now.AddHours(-2)),
            Agent($"{marker}-new", $"{marker}-NEW", DeviceType.Workstation, null));
        (await CheckAsync(rule, [organizationId])).ShouldBe(new CoverageCheckResult(1, 0, 0, 0, 0));
        (await OpenAsync(admin, organizationId)).ShouldHaveSingleItem();
        (await CheckAsync(rule, [organizationId])).ShouldBe(new CoverageCheckResult(1, 0, 0, 0, 1));
        (await OpenAsync(admin, organizationId)).ShouldBeEmpty();
    }

    [Fact]
    public async Task Only_the_customers_the_read_covered_are_checked()
    {
        var (organizationId, marker) = await CustomerAsync();
        var admin = factory.ClientAs(CrmRoles.Admin);
        var rule = $"test.{marker}";
        await DevicesAsync(organizationId, Agent($"{marker}-pc", $"{marker}-PC", DeviceType.Workstation, DateTimeOffset.UtcNow.AddDays(-30)));

        (await CheckAsync(rule, [])).Found.ShouldBe(0);
        (await OpenAsync(admin, organizationId)).ShouldBeEmpty("a customer the read did not cover has no gaps found");
        (await CheckAsync(rule, [organizationId])).Opened.ShouldBe(1);
        (await OpenAsync(admin, organizationId)).ShouldHaveSingleItem().GetProperty("severity").GetString().ShouldBe("Warning");

        // The customer lost its link to Atera: reads no longer cover it, and its gap closes like any gap that is gone.
        await CheckAsync(rule, []);
        (await OpenAsync(admin, organizationId)).ShouldHaveSingleItem();
        await CheckAsync(rule, []);
        (await OpenAsync(admin, organizationId)).ShouldBeEmpty();
    }

    [Fact]
    public async Task The_limit_and_the_switch_are_one_setting_changed_with_the_etag_of_the_rule()
    {
        var admin = factory.ClientAs(CrmRoles.Admin);
        var rule = await RuleAsync(admin);
        var limit = rule.GetProperty("threshold");
        (limit.GetProperty("default").GetInt32(), limit.GetProperty("min").GetInt32(), limit.GetProperty("max").GetInt32(), limit.GetProperty("unit").GetString())
            .ShouldBe((7, 1, 90, "Days"));
        (rule.GetProperty("system").GetString(), rule.GetProperty("enabled").GetBoolean(), rule.GetProperty("value").GetInt32()).ShouldBe(("atera", true, 7));
        var url = $"{Rules}/{Silent}";

        (await admin.PutAsJsonAsync(url, new { enabled = true, threshold = 14 }, Ct)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        await ShouldRefuseAsync(admin.PutWithETagAsync(url, new { enabled = true, threshold = 91 }, Etag(rule)), "SRV_COVERAGE_THRESHOLD");
        await ShouldRefuseAsync(admin.PutWithETagAsync(url, new { enabled = true }, Etag(rule)), "SRV_COVERAGE_THRESHOLD");
        (await admin.PutWithETagAsync($"{Rules}/no.such-rule", new { enabled = true }, Etag(rule))).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await factory.ClientAs(CrmRoles.ReadOnly).PutWithETagAsync(url, new { enabled = true, threshold = 14 }, Etag(rule))).StatusCode
            .ShouldBe(HttpStatusCode.Forbidden);

        var changed = await admin.PutWithETagAsync(url, new { enabled = true, threshold = 14 }, Etag(rule));
        changed.StatusCode.ShouldBe(HttpStatusCode.OK, await changed.Content.ReadAsStringAsync(Ct));
        var fourteen = await changed.ReadJsonAsync();
        fourteen.GetProperty("value").GetInt32().ShouldBe(14);
        fourteen.GetProperty("changedByName").GetString().ShouldNotBeNullOrWhiteSpace();
        (await admin.PutWithETagAsync(url, new { enabled = true, threshold = 10 }, Etag(rule))).StatusCode
            .ShouldBe(HttpStatusCode.PreconditionFailed, "someone changed the rule since it was read");

        try
        {
            // At 14 days an agent silent for 10 is no gap; at 7 it is.
            var (organizationId, marker) = await CustomerAsync();
            await DevicesAsync(organizationId, Agent($"{marker}-pc", $"{marker}-PC", DeviceType.Workstation, DateTimeOffset.UtcNow.AddDays(-10)));
            (await CheckAsync([organizationId])).Found.ShouldBe(0);
            var seven = await (await admin.PutWithETagAsync(url, new { enabled = true, threshold = 7 }, Etag(fourteen))).ReadJsonAsync();
            (await CheckAsync([organizationId])).Opened.ShouldBe(1);
            (await OpenAsync(admin, organizationId)).ShouldHaveSingleItem();

            // Switched off: its open gaps close at once, and a check of a rule that is off finds nothing.
            var off = await admin.PutWithETagAsync(url, new { enabled = false, threshold = 7 }, Etag(await RuleAsync(admin)));
            off.StatusCode.ShouldBe(HttpStatusCode.OK, await off.Content.ReadAsStringAsync(Ct));
            (await off.ReadJsonAsync()).GetProperty("openGaps").GetInt32().ShouldBe(0);
            (await OpenAsync(admin, organizationId)).ShouldBeEmpty();
            (await CheckAsync([organizationId])).Found.ShouldBe(0);
            seven.GetProperty("value").GetInt32().ShouldBe(7);
        }
        finally
        {
            // The setting is the whole CRM's: it goes back to how the migration left it.
            (await admin.PutWithETagAsync(url, new { enabled = true, threshold = 7 }, Etag(await RuleAsync(admin)))).StatusCode.ShouldBe(HttpStatusCode.OK);
        }
    }

    private static ExternalDevice Agent(string id, string name, DeviceType type, DateTimeOffset? lastSeen) =>
        new(id, name, type, "Windows 11 Pro", lastSeen > DateTimeOffset.UtcNow.AddHours(-3), lastSeen, null);

    private async Task<(Guid OrganizationId, string Marker)> CustomerAsync()
    {
        var marker = $"M40{Guid.NewGuid():N}"[..11];
        return (await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Dekning AS", status = "Customer" }), marker);
    }

    private async Task DevicesAsync(Guid organizationId, params ExternalDevice[] devices)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<IServiceApi>().ReplaceDevicesAsync(organizationId, AteraTypes.System, devices, Ct);
    }

    /// <summary>A check of the real rules of Atera, as the nightly read runs it.</summary>
    private async Task<CoverageCheckResult> CheckAsync(IReadOnlyCollection<Guid> organizations)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ICoverageCheck>().CheckAsync(AteraTypes.System, organizations, Ct);
    }

    /// <summary>A check of the silent-agent rule under the test's own code and source, which no other test's check touches.</summary>
    private async Task<CoverageCheckResult> CheckAsync(string code, IReadOnlyCollection<Guid> organizations)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
        var rule = new OwnRule(new AteraAgentSilentRule(db), code);
        return await new CoverageChecks(db, [rule], TimeProvider.System).CheckAsync(rule.System, organizations, Ct);
    }

    private sealed class OwnRule(ICoverageRule silent, string code) : ICoverageRule
    {
        public string Code => code;
        public string System => "m40-" + code;
        public AlertKind Kind => silent.Kind;
        public CoverageThreshold? Threshold => silent.Threshold;
        public Task<IReadOnlyList<CoverageFinding>> FindAsync(CoverageCheck check, CancellationToken cancellationToken) => silent.FindAsync(check, cancellationToken);
    }

    private static async Task<List<JsonElement>> OpenAsync(HttpClient client, Guid organizationId) =>
        (await (await client.GetAsync($"{Alerts}?organizationId={organizationId}", Ct)).ReadJsonAsync()).GetProperty("items").EnumerateArray().ToList();

    private static async Task<JsonElement> RuleAsync(HttpClient client) =>
        (await (await client.GetAsync(Rules, Ct)).ReadJsonAsync()).EnumerateArray().Single(r => r.GetProperty("code").GetString() == Silent);

    private static string Etag(JsonElement rule) => rule.GetProperty("etag").GetString()!;

    private static async Task ShouldRefuseAsync(Task<HttpResponseMessage> call, string code)
    {
        var response = await call;
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync(Ct)).ShouldContain(code);
    }
}
