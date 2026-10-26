using Crm.Integrations.Atera;
using Crm.Integrations.Brreg;
using Crm.Integrations.Core;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;
using Microsoft.Extensions.Configuration;

namespace Crm.UnitTests;

/// <summary>
/// Every recurring integration job of Crm.Worker/Program.cs is late after its own schedule (DEV-17, DEV-19), read from the
/// setting its options class binds and with that class's default, so the connections page never calls a half-hourly read up to
/// date for a day.
/// </summary>
public class FreshnessLimitsTests
{
    private static readonly (string Job, string? Key, string Cron)[] Scheduled =
    [
        (AteraCustomerSyncJob.JobId, Key(AteraOptions.SectionName, nameof(AteraOptions.CustomerSyncCron)), new AteraOptions().CustomerSyncCron),
        (AteraContactSyncJob.JobId, Key(AteraOptions.SectionName, nameof(AteraOptions.ContactSyncCron)), new AteraOptions().ContactSyncCron),
        (AteraWorkHoursSyncJob.JobId, Key(AteraOptions.SectionName, nameof(AteraOptions.WorkHoursSyncCron)), new AteraOptions().WorkHoursSyncCron),
        (AteraAgentSyncJob.JobId, Key(AteraOptions.SectionName, nameof(AteraOptions.AgentSyncCron)), new AteraOptions().AgentSyncCron),
        (AteraAlertSyncJob.JobId, Key(AteraOptions.SectionName, nameof(AteraOptions.AlertSyncCron)), new AteraOptions().AlertSyncCron),
        (PowerOfficeCustomerSyncJob.JobId, Key(PowerOfficeOptions.SectionName, nameof(PowerOfficeOptions.CustomerSyncCron)), new PowerOfficeOptions().CustomerSyncCron),
        (PowerOfficeContactPersonSyncJob.JobId, Key(PowerOfficeOptions.SectionName, nameof(PowerOfficeOptions.ContactPersonSyncCron)),
            new PowerOfficeOptions().ContactPersonSyncCron),
        (PowerOfficeProductSyncJob.JobId, Key(PowerOfficeOptions.SectionName, nameof(PowerOfficeOptions.ProductSyncCron)), new PowerOfficeOptions().ProductSyncCron),
        (PowerOfficeLedgerSyncJob.JobId, Key(PowerOfficeOptions.SectionName, nameof(PowerOfficeOptions.CustomerLedgerSyncCron)),
            new PowerOfficeOptions().CustomerLedgerSyncCron),
        (PowerOfficePdfSyncJob.JobId, Key(PowerOfficeOptions.SectionName, nameof(PowerOfficeOptions.InvoicePdfSyncCron)), new PowerOfficeOptions().InvoicePdfSyncCron),
        (PartnerCenterCustomerSyncJob.JobId, Key(PartnerCenterOptions.SectionName, nameof(PartnerCenterOptions.CustomerSyncCron)),
            new PartnerCenterOptions().CustomerSyncCron),
        (PartnerCenterSubscriptionSyncJob.JobId, Key(PartnerCenterOptions.SectionName, nameof(PartnerCenterOptions.SubscriptionSyncCron)),
            new PartnerCenterOptions().SubscriptionSyncCron),
        (PartnerCenterLicenseSyncJob.JobId, Key(PartnerCenterOptions.SectionName, nameof(PartnerCenterOptions.LicenseSyncCron)),
            new PartnerCenterOptions().LicenseSyncCron),
        (PartnerBillingSyncJob.JobId, Key(PartnerCenterOptions.SectionName, nameof(PartnerCenterOptions.BillingSyncCron)), new PartnerCenterOptions().BillingSyncCron),
        (EntraUserSyncJob.JobId, Key(GraphOptions.SectionName, nameof(GraphOptions.UserSyncCron)), new GraphOptions().UserSyncCron),
        (EntraRoleSyncJob.JobId, Key(GraphOptions.SectionName, nameof(GraphOptions.RoleSyncCron)), new GraphOptions().RoleSyncCron),
        // A fixed schedule: no setting to read.
        (BrregRegistryCheckJob.JobId, null, BrregRegistryCheckJob.Cron),
    ];

    public static TheoryData<string, string?, string> Schedules()
    {
        var data = new TheoryData<string, string?, string>();
        foreach (var (job, key, cron) in Scheduled) data.Add(job, key, cron);
        return data;
    }

    [Theory]
    [MemberData(nameof(Schedules))]
    public void A_recurring_job_is_late_after_its_schedule_from_the_setting_and_default_of_its_options(string job, string? key, string cron)
    {
        FreshnessLimits.Minutes(Configuration(), job).ShouldBe(CronCadence.FreshnessMinutes(cron, "unused")!.Value);
        if (key is not null)
        {
            FreshnessLimits.Minutes(Configuration((key, "0 * * * *")), job).ShouldBe(105, "an hourly schedule in the setting");
        }
    }

    [Fact]
    public void No_other_job_follows_a_schedule_and_the_alert_read_is_late_after_an_hour()
    {
        FreshnessLimits.ScheduledJobs.ShouldBe(Scheduled.Select(s => s.Job), ignoreOrder: true);
        // Twice an hour (5 and 35): late after a gap and a half and a quarter of an hour, not after a day.
        FreshnessLimits.Minutes(Configuration(), AteraAlertSyncJob.JobId).ShouldBe(60);
        FreshnessLimits.Minutes(Configuration(), EntraRoleSyncJob.JobId).ShouldBe(18);
        FreshnessLimits.Minutes(Configuration(), BrregRegistryCheckJob.JobId).ShouldBe(2175);
    }

    [Fact]
    public void The_specification_limits_an_explicit_limit_and_the_fallback_still_apply()
    {
        FreshnessLimits.Minutes(Configuration(), AteraTicketSyncJob.OpenJobId).ShouldBe(15);
        FreshnessLimits.Minutes(Configuration(), AteraTicketSyncJob.RecentJobId).ShouldBe(15);
        FreshnessLimits.Minutes(Configuration(), PowerOfficeInvoiceSyncJob.JobId).ShouldBe(90);
        FreshnessLimits.Minutes(Configuration(("Monitoring:Freshness:atera-alerts", "10")), AteraAlertSyncJob.JobId).ShouldBe(10);
        FreshnessLimits.Minutes(Configuration(), "synthetic-job").ShouldBe(1440);
        FreshnessLimits.Minutes(Configuration(("Monitoring:FreshnessMinutes", "30")), "synthetic-job").ShouldBe(30);
        // A schedule restricted to some days is not read: the general limit applies.
        FreshnessLimits.Minutes(Configuration((Key(AteraOptions.SectionName, nameof(AteraOptions.AlertSyncCron)), "0 0 31 2 *")), AteraAlertSyncJob.JobId)
            .ShouldBe(1440);
    }

    private static string Key(string section, string property) => $"{section}:{property}";

    private static IConfiguration Configuration(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();
}
