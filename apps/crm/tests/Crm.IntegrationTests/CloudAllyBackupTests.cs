using System.Globalization;
using System.Net;
using System.Text.Json;
using Crm.Backup.Persistence;
using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Licensing.Contracts;
using Crm.Service.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.CloudAllyHost;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M42 on SQL Server: the CloudAlly read stores the linked customers' backups as one snapshot — tasks, their mailboxes, OneDrives and
/// sites, joined to CloudAlly's statuses — and forgets what a complete read no longer lists; a read that fails part-way changes
/// nothing. The Sikkerhetskopi tab reads the states the coverage rules see, and the rules raise gaps of the CRM's own after the read.
/// </summary>
[Collection(CloudAllyCollection.Name)]
public sealed class CloudAllyBackupTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_complete_read_stores_the_linked_backups_and_the_tab_shows_each_state_problems_first()
    {
        await using var host = Start(factory);
        var kari = Entity("kari@fjord.test", fullName: "Kari Nordmann");
        var ola = Entity("ola@fjord.test", successHoursAgo: 30, attemptHoursAgo: 2, error: "Mailbox is full", fullName: "Ola Nordmann");
        var nina = Entity("nina@fjord.test", status: "NOTACTIVE", successHoursAgo: null);
        var site = Entity("Prosjekter", successHoursAgo: 80);
        var account = await host.LinkedAccountAsync("Fjord IT",
            ("MS365", "ACTIVE", [kari, ola, nina]), ("ONEDRIVE", "ACTIVE", [Entity("kari@fjord.test")]), ("SHAREPOINT_MULTI", "PAUSED", [site]));
        var unlinked = host.Account("Ukjent AS", null, ("MS365", "ACTIVE", [Entity("someone@ukjent.test")]));
        host.Publish();

        await host.SyncAsync();

        var overview = await OverviewAsync(host, account);
        overview.GetProperty("read").GetProperty("complete").GetBoolean().ShouldBeTrue();
        overview.GetProperty("lateAfterHours").GetInt32().ShouldBe(26);
        var accounts = overview.GetProperty("accounts").EnumerateArray().ToList();
        (accounts.ShouldHaveSingleItem().GetProperty("region").GetString(), accounts[0].GetProperty("outsideRegion").GetBoolean()).ShouldBe(("EU", false));
        var services = overview.GetProperty("services").EnumerateArray().ToDictionary(s => s.GetProperty("service").GetString()!);
        var mail = services["Mail"];
        (mail.GetProperty("total").GetInt32(), mail.GetProperty("ok").GetInt32(), mail.GetProperty("failed").GetInt32(), mail.GetProperty("notInBackup").GetInt32())
            .ShouldBe((2, 1, 1, 1));
        services["OneDrive"].GetProperty("ok").GetInt32().ShouldBe(1);
        services["SharePoint"].GetProperty("paused").GetInt32().ShouldBe(1);
        overview.GetProperty("tasks").EnumerateArray().Single(t => t.GetProperty("service").GetString() == "SharePoint").GetProperty("paused").GetBoolean().ShouldBeTrue();
        overview.GetProperty("licences").GetProperty("state").GetString().ShouldBe("NoData", "Partner Center has no licence reading of the customer");

        var problems = await EntitiesAsync(host, account, "state=problems");
        problems.Select(e => (e.GetProperty("name").GetString(), e.GetProperty("state").GetString()))
            .ShouldBe([("ola@fjord.test", "Failed"), ("Prosjekter", "Paused"), ("nina@fjord.test", "NotInBackup")]);
        (problems[0].GetProperty("error").GetString(), problems[0].GetProperty("errorLink").GetString(), problems[0].GetProperty("fullName").GetString())
            .ShouldBe(("Mailbox is full", "https://support.cloudally.test/faq", "Ola Nordmann"));

        // Five entities in pages of two: the cursor carries the state's rank, the name and the id.
        var first = await (await host.Client().GetAsync($"/api/v1/backup/organizations/{account.OrganizationId}/entities?limit=2", Ct)).ReadJsonAsync();
        first.GetProperty("totalCount").GetInt32().ShouldBe(5);
        var names = first.GetProperty("items").EnumerateArray().Select(e => e.GetProperty("name").GetString()).ToList();
        for (var cursor = first.GetProperty("nextCursor").GetString(); cursor is not null;)
        {
            var next = await (await host.Client().GetAsync(
                $"/api/v1/backup/organizations/{account.OrganizationId}/entities?limit=2&cursor={Uri.EscapeDataString(cursor)}", Ct)).ReadJsonAsync();
            names.AddRange(next.GetProperty("items").EnumerateArray().Select(e => e.GetProperty("name").GetString()));
            cursor = next.GetProperty("nextCursor").GetString();
        }

        names.ShouldBe(["ola@fjord.test", "Prosjekter", "nina@fjord.test", "kari@fjord.test", "kari@fjord.test"]);
        (await EntitiesAsync(host, account, "service=OneDrive")).ShouldHaveSingleItem().GetProperty("state").GetString().ShouldBe("Ok");
        (await EntitiesAsync(host, account, "q=nordmann")).Count.ShouldBe(2, "the person's name is searched too");
        (await host.Client().GetAsync($"/api/v1/backup/organizations/{account.OrganizationId}/entities?state=Sleeping", Ct)).StatusCode
            .ShouldBe(HttpStatusCode.BadRequest);

        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<BackupDbContext>().Accounts.AnyAsync(a => a.ExternalId == unlinked.Id, Ct))
            .ShouldBeFalse("an account no organization is linked to is not stored");
    }

    [Fact]
    public async Task The_coverage_rules_find_a_failed_and_a_paused_backup_and_close_them_after_two_clean_reads()
    {
        await using var host = Start(factory);
        var kari = Entity("kari@fjell.test");
        var ola = Entity("ola@fjell.test", successHoursAgo: 30, attemptHoursAgo: 2, error: "Mailbox is full");
        var account = await host.LinkedAccountAsync("Fjell IT", ("MS365", "ACTIVE", [kari, ola]), ("SHAREPOINT_MULTI", "PAUSED", [Entity("Intranett")]));
        host.Publish();

        await host.SyncAsync();

        var gaps = await GapsAsync(host, account);
        gaps.Select(g => (g.GetProperty("rule").GetString(), g.GetProperty("severity").GetString(), g.GetProperty("kind").GetString()))
            .OrderBy(g => g.Item1)
            .ShouldBe([("cloudally.backup-failed", "Warning", "Backup"), ("cloudally.backup-paused", "Warning", "Backup")]);
        var failed = gaps.Single(g => g.GetProperty("rule").GetString() == "cloudally.backup-failed");
        var facts = failed.GetProperty("facts");
        (facts.GetProperty("service").GetString(), facts.GetProperty("failed").GetString(), facts.GetProperty("total").GetString(), facts.GetProperty("account").GetString())
            .ShouldBe(("Mail", "1", "2", "Fjell IT"));
        failed.GetProperty("title").GetString().ShouldBe("The CloudAlly backup of Mail failed for 1 of 2 at Fjell IT");

        // Ola's backup works again and the site is resumed: one clean read keeps the gaps open, the second closes them.
        account.Tasks[0].Entities[1] = ola with { Success = DateTimeOffset.UtcNow.AddMinutes(-5), Attempt = DateTimeOffset.UtcNow.AddMinutes(-5), Error = null };
        account.Tasks[1] = account.Tasks[1] with { Status = "ACTIVE" };
        host.Publish();
        await host.SyncAsync();
        (await GapsAsync(host, account)).Count.ShouldBe(2, "one clean check does not close a gap");
        await host.SyncAsync();
        (await GapsAsync(host, account)).ShouldBeEmpty();
    }

    [Fact]
    public async Task The_whole_service_failing_is_critical_and_a_backup_older_than_the_limit_is_late_not_failed()
    {
        await using var host = Start(factory);
        var account = await host.LinkedAccountAsync("Havbris",
            ("MS365", "ACTIVE", [Entity("a@havbris.test", successHoursAgo: 50, attemptHoursAgo: 1, error: "Consent revoked"),
                Entity("b@havbris.test", successHoursAgo: 50, attemptHoursAgo: 1, error: "Consent revoked")]),
            ("ONEDRIVE", "ACTIVE", [Entity("a@havbris.test", successHoursAgo: 30), Entity("b@havbris.test", successHoursAgo: 3)]));
        host.Publish();

        await host.SyncAsync();

        var gaps = (await GapsAsync(host, account)).ToDictionary(g => g.GetProperty("rule").GetString()!);
        gaps["cloudally.backup-failed"].GetProperty("severity").GetString().ShouldBe("Critical", "every mailbox of the task failed");
        var late = gaps["cloudally.backup-late"];
        (late.GetProperty("severity").GetString(), late.GetProperty("facts").GetProperty("late").GetString(), late.GetProperty("facts").GetProperty("hours").GetString())
            .ShouldBe(("Warning", "1", "26"));
        gaps.Count.ShouldBe(2, "a failed mailbox is the failed rule's, not also the late rule's");
    }

    [Fact]
    public async Task Licensed_users_are_counted_from_partner_center_and_more_licences_than_mailboxes_in_backup_is_a_gap()
    {
        await using var host = Start(factory);
        var account = await host.LinkedAccountAsync("Lisens",
            ("MS365", "ACTIVE", [Entity("a@lisens.test"), Entity("b@lisens.test"), Entity("c@lisens.test", status: "NOTACTIVE", successHoursAgo: null)]));
        var organizationId = account.OrganizationId!.Value;
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);
        await factory.RunJobAsync<ILicensingApi>(api => api.UpsertLicenseUsageAsync(
            [new LicenseUsageReading(organizationId, Guid.NewGuid().ToString(), "SPB", 4, 3), new LicenseUsageReading(organizationId, Guid.NewGuid().ToString(), "POWER_BI_PRO", 9, 9)],
            today, CancellationToken.None));
        host.Publish();

        await host.SyncAsync();

        var licences = (await OverviewAsync(host, account)).GetProperty("licences");
        (licences.GetProperty("state").GetString(), licences.GetProperty("licensed").GetInt32(), licences.GetProperty("backedUp").GetInt32(), licences.GetProperty("missing").GetInt32())
            .ShouldBe(("Checked", 3, 2, 1));
        var gap = (await GapsAsync(host, account)).ShouldHaveSingleItem();
        gap.GetProperty("rule").GetString().ShouldBe("cloudally.user-not-backed-up");
        var facts = gap.GetProperty("facts");
        (facts.GetProperty("licensed").GetString(), facts.GetProperty("backedUp").GetString(), facts.GetProperty("missing").GetString(), facts.GetProperty("readOn").GetString())
            .ShouldBe(("3", "2", "1", today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)));
    }

    [Fact]
    public async Task A_read_that_fails_part_way_changes_nothing_and_a_complete_one_forgets_what_cloudally_no_longer_lists()
    {
        await using var host = Start(factory);
        var account = await host.LinkedAccountAsync("Glemt", ("MS365", "ACTIVE", [Entity("a@glemt.test"), Entity("b@glemt.test")]));
        host.Publish();
        await host.SyncAsync();
        (await EntitiesAsync(host, account, string.Empty)).Count.ShouldBe(2);

        account.Tasks[0].Entities.RemoveAt(1);
        host.Publish(statusesFail: true);
        await Should.ThrowAsync<SyncFailedException>(host.SyncAsync);
        (await EntitiesAsync(host, account, string.Empty)).Count.ShouldBe(2, "a read that failed part-way stores nothing");
        (await LatestRunAsync(host)).ShouldBe("Failed");

        host.Publish();
        await host.SyncAsync();
        (await EntitiesAsync(host, account, string.Empty)).ShouldHaveSingleItem().GetProperty("name").GetString().ShouldBe("a@glemt.test");

        host.Accounts.Remove(account);
        host.Publish();
        await host.SyncAsync();
        var overview = await OverviewAsync(host, account);
        (overview.GetProperty("accounts").GetArrayLength(), overview.GetProperty("licences").GetProperty("state").GetString())
            .ShouldBe((0, "NoAccount"), "an account CloudAlly no longer lists is forgotten with its tasks");
    }

    private static async Task<JsonElement> OverviewAsync(CloudAllyHost host, TestAccount account)
    {
        var response = await host.Client().GetAsync($"/api/v1/backup/organizations/{account.OrganizationId}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    private static async Task<List<JsonElement>> EntitiesAsync(CloudAllyHost host, TestAccount account, string query)
    {
        var response = await host.Client().GetAsync($"/api/v1/backup/organizations/{account.OrganizationId}/entities?{query}", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return (await response.ReadJsonAsync()).GetProperty("items").EnumerateArray().ToList();
    }

    private static async Task<List<JsonElement>> GapsAsync(CloudAllyHost host, TestAccount account) =>
        (await (await host.Client().GetAsync($"/api/v1/service/alerts?organizationId={account.OrganizationId}", Ct)).ReadJsonAsync())
            .GetProperty("items").EnumerateArray().Where(a => a.GetProperty("system").GetString() == CoverageGaps.System).ToList();

    private static async Task<string> LatestRunAsync(CloudAllyHost host)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().SyncRuns.AsNoTracking()
            .Where(r => r.System == CloudAllyTypes.System && r.Job == CloudAllyBackupSyncJob.JobId)
            .OrderByDescending(r => r.StartedAt).FirstAsync(Ct)).Status.ToString();
    }
}
