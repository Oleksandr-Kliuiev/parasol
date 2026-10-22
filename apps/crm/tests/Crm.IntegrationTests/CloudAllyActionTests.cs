using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Backup.Persistence;
using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core.Actions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.CloudAllyHost;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M42 on SQL Server: CloudAlly's actions on the one action path. A preview names the backup from the saved copy and what will happen;
/// the attempt reads CloudAlly first and skips or refuses what no longer fits; a pause asks for a reason, closing an account and a
/// restore in place for the full destructive confirmation; a restore is never repeated without a clear answer.
/// </summary>
[Collection(CloudAllyCollection.Name)]
public sealed class CloudAllyActionTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Taking_a_backup_now_posts_once_and_stores_what_cloudally_shows_afterwards()
    {
        await using var host = Start(factory);
        var account = await StoredAsync(host, ("MS365", "ACTIVE", [Entity("kari@run.test", successHoursAgo: 40)]));
        var task = account.Tasks[0];
        host.Publish();
        host.On("POST", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}/backupNow").RespondWith(JsonReply(new { success = true, status = "OK", statusCode = 200 }));

        var preview = await host.PreviewAsync(CloudAllyActionKinds.Run, CloudAllyActionKinds.TaskTarget, task.Id, new { });
        (preview.GetProperty("level").GetString(), preview.GetProperty("target").GetProperty("name").GetString()).ShouldBe(("Standard", "Run AS · MS365"));
        preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString()).ShouldBe(["VND_EFFECT_BACKUP_RUN_ALL", "VND_EFFECT_BACKUP_QUEUE"]);

        var action = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.Run, CloudAllyActionKinds.TaskTarget, task.Id, new { }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_BACKUP_STARTED"));
        host.Count("POST", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}/backupNow").ShouldBe(1);
        host.Headers("POST", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}/backupNow")["Authorization"].ShouldBe("Bearer test-token");
        host.Count("GET", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}").ShouldBe(2, "read before sending and again after");
    }

    [Fact]
    public async Task A_paused_backup_is_not_run_and_an_entity_not_in_backup_is_added_and_billed()
    {
        await using var host = Start(factory);
        var nina = Entity("nina@add.test", status: "NOTACTIVE", successHoursAgo: null);
        var account = await StoredAsync(host, ("MS365", "PAUSED", [Entity("kari@add.test"), nina]));
        var task = account.Tasks[0];
        (await host.PreviewAsync(CloudAllyActionKinds.Run, CloudAllyActionKinds.TaskTarget, task.Id, new { })).GetProperty("block").GetProperty("code").GetString()
            .ShouldBe("VND_BACKUP_PAUSED");
        (await host.PreviewAsync(CloudAllyActionKinds.Activate, CloudAllyActionKinds.EntityTarget, account.Tasks[0].Entities[0].Id, new { task = task.Id }))
            .GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_BACKUP_ALREADY_ACTIVE");

        var preview = await host.PreviewAsync(CloudAllyActionKinds.Activate, CloudAllyActionKinds.EntityTarget, nina.Id, new { task = task.Id });
        preview.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString()).ShouldBe(["VND_EFFECT_BACKUP_ACTIVATE", "VND_EFFECT_BACKUP_BILLED"]);
        host.Publish();
        // CloudAlly shows the user outside the backup until the activation went through, and in it afterwards.
        var taskPath = $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}";
        var path = $"{taskPath}/entities/{nina.Id}/activate";
        var before = View(task);
        task.Entities[1] = nina with { Status = "ACTIVE" };
        var after = View(task);
        // The first read replaces the task's published route (same mapping id), the others follow the scenario.
        host.On("GET", taskPath).InScenario(nina.Id).WillSetStateTo("read").RespondWith(JsonReply(before));
        host.CloudAlly.Given(Request.Create().WithPath(taskPath).UsingGet()).InScenario(nina.Id).WhenStateIs("read").RespondWith(JsonReply(before));
        host.CloudAlly.Given(Request.Create().WithPath(path).UsingPost()).InScenario(nina.Id).WhenStateIs("read").WillSetStateTo("done")
            .RespondWith(JsonReply(new { success = true, status = "OK", statusCode = 200 }));
        host.CloudAlly.Given(Request.Create().WithPath(taskPath).UsingGet()).InScenario(nina.Id).WhenStateIs("done").RespondWith(JsonReply(after));
        var id = await host.AskAsync(CloudAllyActionKinds.Activate, CloudAllyActionKinds.EntityTarget, nina.Id, new { task = task.Id });

        var action = await host.RunAsync(id);

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        host.Count("POST", path).ShouldBe(1);
        await using var scope = host.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<BackupDbContext>().Entities.AsNoTracking().SingleAsync(e => e.ExternalId == nina.Id, Ct)).Status
            .ShouldBe("ACTIVE", "the read after the activation is stored at once");
    }

    [Fact]
    public async Task A_pause_asks_for_a_reason_and_one_already_paused_at_cloudally_is_skipped()
    {
        await using var host = Start(factory);
        var account = await StoredAsync(host, ("ONEDRIVE", "ACTIVE", [Entity("kari@pause.test")]));
        var task = account.Tasks[0];
        var preview = await host.PreviewAsync(CloudAllyActionKinds.Pause, CloudAllyActionKinds.TaskTarget, task.Id, new { });
        (preview.GetProperty("level").GetString(), preview.GetProperty("confirmation").GetProperty("reason").GetBoolean()).ShouldBe(("Disruptive", true));
        var refused = await host.Client().PostAsJsonAsync("/api/v1/actions", new
        {
            system = CloudAllyTypes.System, kind = CloudAllyActionKinds.Pause, targetType = CloudAllyActionKinds.TaskTarget, targetId = task.Id,
            parameters = new { }, previewToken = preview.GetProperty("previewToken").GetString(), commandKey = Guid.NewGuid(),
        }, Ct);
        refused.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("VND_REASON_REQUIRED");

        // Someone paused it in CloudAlly's portal meanwhile.
        account.Tasks[0] = task with { Status = "PAUSED" };
        host.Publish();
        var action = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.Pause, CloudAllyActionKinds.TaskTarget, task.Id, new { },
            reason: "The customer moves the files to a new tenant this week"));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Skipped, "VND_ALREADY_DONE"));
        host.Count("POST", $"/v2/resellers/accounts/{account.Id}/backup-tasks/{task.Id}/pause").ShouldBe(0);
    }

    [Fact]
    public async Task Closing_an_account_is_destructive_waits_out_its_hold_and_carries_the_application_headers()
    {
        await using var host = Start(factory);
        var account = await StoredAsync(host, ("MS365", "ACTIVE", [Entity("kari@close.test")]));
        host.Publish();
        host.On("DELETE", $"/v2/resellers/accounts/{account.Id}").RespondWith(JsonReply(new { success = true, status = "Deleted", statusCode = 200 }));
        var preview = await host.PreviewAsync(CloudAllyActionKinds.Deactivate, CloudAllyActionKinds.AccountTarget, account.Id, new { });
        var confirmation = preview.GetProperty("confirmation");
        (preview.GetProperty("level").GetString(), confirmation.GetProperty("typedName").GetBoolean(), confirmation.GetProperty("holdSeconds").GetInt32())
            .ShouldBe(("Destructive", true, 60));

        var id = await host.AskAsync(CloudAllyActionKinds.Deactivate, CloudAllyActionKinds.AccountTarget, account.Id, new { },
            reason: "The customer ended the backup agreement", typedName: account.Name);
        (await host.RunAsync(id, holdPassed: false)).Status.ShouldBe(VendorActionStatus.Scheduled, "the hold has not passed");
        var action = await host.RunAsync(id);

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_SENT"));
        var headers = host.Headers("DELETE", $"/v2/resellers/accounts/{account.Id}");
        (headers["client-id"], headers["client-secret"]).ShouldBe(("test-client", "test-secret"));
    }

    [Fact]
    public async Task An_export_sends_the_mailbox_the_day_and_pst_and_a_restore_elsewhere_stays_in_the_domain()
    {
        await using var host = Start(factory);
        var kari = Entity("kari@restore.test", fullName: "Kari Nordmann");
        var account = await StoredAsync(host, ("MS365", "ACTIVE", [kari]));
        var task = account.Tasks[0];
        host.Publish();
        host.On("POST", $"/v2/resellers/accounts/{account.Id}/recovery/export").RespondWith(JsonReply(new { }));
        host.On("POST", $"/v2/resellers/accounts/{account.Id}/recovery/restore").RespondWith(JsonReply(new { needRedirect = false, showNotification = true }));
        var tomorrow = DateTime.UtcNow.AddDays(2).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
        (await host.PreviewAsync(CloudAllyActionKinds.Export, CloudAllyActionKinds.EntityTarget, kari.Id, new { task = task.Id, date = tomorrow }))
            .GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_RESTORE_DATE");
        (await host.PreviewAsync(CloudAllyActionKinds.RestoreOther, CloudAllyActionKinds.EntityTarget, kari.Id, new { task = task.Id, date = "2026-10-05", target = "ola@elsewhere.test" }))
            .GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_RESTORE_TARGET_DOMAIN");

        var export = await host.PreviewAsync(CloudAllyActionKinds.Export, CloudAllyActionKinds.EntityTarget, kari.Id, new { task = task.Id, date = "2026-10-05", includeDeleted = true });
        (export.GetProperty("level").GetString(), export.GetProperty("target").GetProperty("name").GetString()).ShouldBe(("Disruptive", "kari@restore.test"));
        export.GetProperty("effects").EnumerateArray().Select(e => e.GetProperty("code").GetString())
            .ShouldBe(["VND_EFFECT_RESTORE_EXPORT", "VND_EFFECT_RESTORE_DELETED", "VND_EFFECT_RESTORE_LINK"]);
        var exported = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.Export, CloudAllyActionKinds.EntityTarget, kari.Id,
            new { task = task.Id, date = "2026-10-05", includeDeleted = true }, reason: "The customer's lawyer needs the mailbox as it was"));
        (exported.Status, exported.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_EXPORT_STARTED"));
        var body = host.Posted($"/v2/resellers/accounts/{account.Id}/recovery/export");
        (body.GetProperty("taskId").GetString(), body.GetProperty("account").GetString(), body.GetProperty("source").GetString(), body.GetProperty("date").GetInt64(),
            body.GetProperty("includeDeleted").GetBoolean(), body.GetProperty("downloadToPst").GetBoolean(), body.GetProperty("extid").GetString())
            .ShouldBe((task.Id, "kari@restore.test", "MS365", 20261005235959L, true, true, "x-" + kari.Id));

        var other = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.RestoreOther, CloudAllyActionKinds.EntityTarget, kari.Id,
            new { task = task.Id, date = "2026-10-05", target = "Ola@Restore.test" }, reason: "Ola takes over Kari's customers and needs her mail"));
        (other.Status, other.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_RESTORE_STARTED"));
        var restore = host.Posted($"/v2/resellers/accounts/{account.Id}/recovery/restore");
        restore.GetProperty("targetAccount").GetString().ShouldBe("ola@restore.test");
        restore.TryGetProperty("inPlace", out _).ShouldBeFalse("a mailbox has no in-place flag; CloudAlly's restore of mail goes by the account");
    }

    [Fact]
    public async Task A_restore_in_place_is_destructive_and_a_sign_in_cloudally_asks_for_leaves_it_to_a_person()
    {
        await using var host = Start(factory);
        var drive = Entity("kari@inplace.test");
        var account = await StoredAsync(host, ("ONEDRIVE", "ACTIVE", [drive]));
        var task = account.Tasks[0];
        host.Publish();
        host.On("POST", $"/v2/resellers/accounts/{account.Id}/recovery/restore")
            .RespondWith(JsonReply(new { needRedirect = true, redirectUrl = "https://login.example.invalid/consent" }));
        var parameters = new { task = task.Id, date = "2026-10-05" };
        (await host.PreviewAsync(CloudAllyActionKinds.RestoreInPlace, CloudAllyActionKinds.EntityTarget, drive.Id, parameters)).GetProperty("level").GetString()
            .ShouldBe("Destructive");

        var action = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.RestoreInPlace, CloudAllyActionKinds.EntityTarget, drive.Id, parameters,
            reason: "Ransomware encrypted the user's files yesterday", typedName: "kari@inplace.test"));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Uncertain, "VND_RESTORE_SIGN_IN"));
        host.Posted($"/v2/resellers/accounts/{account.Id}/recovery/restore").GetProperty("inPlace").GetBoolean().ShouldBeTrue();
        host.CloudAlly.LogEntries.ShouldNotContain(e => e.RequestMessage!.Url.Contains("login.example.invalid"), "the CRM never follows the sign-in address");
    }

    [Fact]
    public async Task In_test_mode_cloudally_is_read_and_nothing_is_sent()
    {
        await using var host = Start(factory, write: false, dryRun: true);
        var account = await StoredAsync(host, ("MS365", "ACTIVE", [Entity("kari@dry.test")]));
        host.Publish();

        var action = await host.RunAsync(await host.AskAsync(CloudAllyActionKinds.Run, CloudAllyActionKinds.TaskTarget, account.Tasks[0].Id, new { }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Simulated, "VND_DRY_RUN"));
        host.CloudAlly.LogEntries.ShouldNotContain(e => e.RequestMessage!.Method == "POST" && e.RequestMessage.Path.Contains("backupNow"));
    }

    /// <summary>A new customer linked to a new account of the world, its backups stored as a complete read would store them.</summary>
    private static async Task<TestAccount> StoredAsync(CloudAllyHost host, params (string Source, string Status, TestEntity[] Entities)[] tasks)
    {
        var name = tasks[0].Entities[0].Name.Split('@')[1].Split('.')[0];
        var account = await host.LinkedAccountAsync(char.ToUpperInvariant(name[0]) + name[1..] + " AS", tasks);
        await host.StoreAsync(account);
        return account;
    }
}
