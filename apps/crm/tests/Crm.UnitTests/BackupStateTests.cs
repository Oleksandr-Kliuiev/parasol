using System.Text.Json;
using Crm.Backup;
using Crm.Backup.Contracts;
using Crm.Backup.Domain;
using Crm.Integrations.CloudAlly;

namespace Crm.UnitTests;

/// <summary>
/// M42: where a backed-up mailbox, OneDrive or site stands — the rules the tab, its filters and the coverage rules share — and how
/// CloudAlly's task, entities and statuses become the backup module's records.
/// </summary>
public class BackupStateTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 22, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Late = TimeSpan.FromHours(26);

    private static BackupEntityFacts Facts(
        string? status = "ACTIVE", bool running = false, double? backupHoursAgo = 2, double? attemptHoursAgo = null, string? error = null,
        double firstSeenHoursAgo = 500) =>
        new(status, running, backupHoursAgo is { } b ? Now.AddHours(-b) : null, attemptHoursAgo is { } a ? Now.AddHours(-a) : null, error,
            Now.AddHours(-firstSeenHoursAgo));

    public static TheoryData<string, BackupEntityFacts, string?, BackupEntityState> Cases() => new()
    {
        { "backed up two hours ago", Facts(), "ACTIVE", BackupEntityState.Ok },
        { "an attempt and a success of the same run", Facts(backupHoursAgo: 2, attemptHoursAgo: 2.01), "ACTIVE", BackupEntityState.Ok },
        { "the last attempt after the last success", Facts(backupHoursAgo: 20, attemptHoursAgo: 2), "ACTIVE", BackupEntityState.Failed },
        { "an attempt and never a success", Facts(backupHoursAgo: null, attemptHoursAgo: 2), "ACTIVE", BackupEntityState.Failed },
        { "an error from CloudAlly, whatever the times", Facts(error: "Mailbox not found"), "ACTIVE", BackupEntityState.Failed },
        { "a run in progress moved the attempt first", Facts(backupHoursAgo: 20, attemptHoursAgo: 0.1, running: true), "ACTIVE", BackupEntityState.Ok },
        { "older than the limit", Facts(backupHoursAgo: 27), "ACTIVE", BackupEntityState.Late },
        { "never backed up, known for longer than the limit", Facts(backupHoursAgo: null), "ACTIVE", BackupEntityState.Late },
        { "never backed up, just added", Facts(backupHoursAgo: null, firstSeenHoursAgo: 3), "ACTIVE", BackupEntityState.Waiting },
        { "the task is paused", Facts(backupHoursAgo: 80), "PAUSED", BackupEntityState.Paused },
        { "the entity is paused", Facts(status: "PAUSED", backupHoursAgo: 80), "ACTIVE", BackupEntityState.Paused },
        { "known to CloudAlly but not backed up", Facts(status: "NOTACTIVE", backupHoursAgo: null), "ACTIVE", BackupEntityState.NotInBackup },
        { "backed up in another task", Facts(status: "IN_ANOTHER", backupHoursAgo: null), "ACTIVE", BackupEntityState.Aside },
        { "archived: gone from the tenant, the backup kept", Facts(status: "ARCHIVED", backupHoursAgo: 900), "PAUSED", BackupEntityState.Aside },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void An_entity_has_one_state(string what, BackupEntityFacts facts, string? taskStatus, BackupEntityState state)
    {
        BackupStates.Of(taskStatus, facts, Now, Late).ShouldBe(state, what);
    }

    [Fact]
    public void Problems_are_the_states_that_need_someone()
    {
        Enum.GetValues<BackupEntityState>().Where(BackupStates.IsProblem)
            .ShouldBe([BackupEntityState.Failed, BackupEntityState.Late, BackupEntityState.Paused, BackupEntityState.NotInBackup]);
    }

    [Theory]
    [InlineData("EU", false)]
    [InlineData("EU_FRANKFURT", false)]
    [InlineData("eu_stockholm", false)]
    [InlineData("LONDON", true)]
    [InlineData("US_EST", true)]
    [InlineData(null, false)]
    public void An_account_outside_the_eu_is_marked(string? region, bool outside) => new BackupOptions().IsOutside(region).ShouldBe(outside);

    [Theory]
    [InlineData("SPB", true)]
    [InlineData("O365_BUSINESS_PREMIUM", true)]
    [InlineData("SPE_E3_USGOV_DOD", true)]
    [InlineData("EXCHANGEARCHIVE_ADDON", false)]
    [InlineData("POWER_BI_PRO", false)]
    [InlineData("O365_BUSINESS", false)]
    public void Licences_with_a_mailbox_are_counted(string sku, bool counted) => new BackupOptions().GivesMailbox(sku).ShouldBe(counted);

    [Fact]
    public void A_task_joins_each_entity_to_its_status_by_name_and_keeps_cloudallys_words()
    {
        using var task = JsonDocument.Parse("""
            {"id":"t1","type":"BACKUP","source":"MS365","userId":"acc-1","status":"ACTIVE","alias":"Exchange",
             "lastBackupDates":{"mail":20261022060000,"calendar":20261022050000},"numOfEntities":3,"numOfBilledEntities":2,
             "entities":[
               {"id":"e1","entity":"Kari@Fjord.no","fullName":"Kari Nordmann","status":"ACTIVE","extId":"x1"},
               {"id":"e2","entity":"ola@fjord.no","status":"ACTIVE","lastBackupDates":{"mail":20261020060000},"progress":{"state":"BACKUP","current":10}},
               {"id":"e3","entity":"ny@fjord.no","status":"NOTACTIVE"}]}
            """);
        var statuses = CloudAllyBackupMapping.Index([
            new CaEntityStatus("acc-1", "t1", "MS365", "kari@fjord.no", Json("\"20261022060000\""), Json("\"20261022070000\""), 2048,
                [new CaSubStatus("mail", "FAILED", "Mailbox is full", "https://support.cloudally.test/full"), new CaSubStatus("calendar", "OK", null, null)], "LICENSED"),
        ]);

        var mapped = CloudAllyBackupMapping.Task(task.RootElement.Deserialize<CaTask>(new JsonSerializerOptions(JsonSerializerDefaults.Web))!, statuses);

        mapped.Service.ShouldBe(BackupService.Mail);
        mapped.LastBackupAt.ShouldBe(new DateTimeOffset(2026, 10, 22, 6, 0, 0, TimeSpan.Zero));
        (mapped.EntityCount, mapped.BilledEntities).ShouldBe((3, 2));
        var kari = mapped.Entities.Single(e => e.ExternalId == "e1");
        (kari.Name, kari.FullName, kari.ExtId, kari.Error, kari.ErrorLink, kari.Licensing).ShouldBe(
            ("Kari@Fjord.no", "Kari Nordmann", "x1", "Mailbox is full", "https://support.cloudally.test/full", "LICENSED"));
        kari.LastAttemptAt.ShouldBe(new DateTimeOffset(2026, 10, 22, 7, 0, 0, TimeSpan.Zero));
        var ola = mapped.Entities.Single(e => e.ExternalId == "e2");
        (ola.Running, ola.LastBackupAt, ola.LastAttemptAt).ShouldBe((true, new DateTimeOffset(2026, 10, 20, 6, 0, 0, TimeSpan.Zero), (DateTimeOffset?)null));
        mapped.Entities.Single(e => e.ExternalId == "e3").Status.ShouldBe("NOTACTIVE");
    }

    [Fact]
    public void A_name_with_one_status_per_part_keeps_its_oldest_success_and_newest_attempt()
    {
        var index = CloudAllyBackupMapping.Index([
            new CaEntityStatus("acc-1", "t1", "O365MAIL", "kari@fjord.no", Json("\"20261022060000\""), Json("\"20261022060000\""), 10, [], null),
            new CaEntityStatus("acc-1", "t1", "O365CALENDAR", "KARI@fjord.no", Json("\"20261021060000\""), Json("\"20261022080000\""), 5,
                [new CaSubStatus("calendar", "FAILED", "Throttled", null)], null),
        ]);

        var merged = index.ShouldHaveSingleItem().Value;
        CloudAllyDates.Parse(merged.LastBackupDate).ShouldBe(new DateTimeOffset(2026, 10, 21, 6, 0, 0, TimeSpan.Zero));
        CloudAllyDates.Parse(merged.LastBackupAttemptDate).ShouldBe(new DateTimeOffset(2026, 10, 22, 8, 0, 0, TimeSpan.Zero));
        merged.BackupStatus!.ShouldHaveSingleItem().Error.ShouldBe("Throttled");
        merged.Size.ShouldBe(15);
    }

    [Theory]
    [InlineData(0, 22, 22)] // CloudAlly's line billed per user: no seats, the users in accounts.
    [InlineData(25, 22, 25)] // A plan that sells seats bills the seats.
    [InlineData(null, 14, 14)]
    [InlineData(0, null, 0)]
    [InlineData(null, null, null)]
    public void A_bill_line_bills_its_seats_where_its_plan_sells_seats_else_its_accounts(int? seats, int? accounts, int? users) =>
        BackupBillCounts.Users(seats, accounts).ShouldBe(users);

    private static JsonElement Json(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.Clone();
    }
}
