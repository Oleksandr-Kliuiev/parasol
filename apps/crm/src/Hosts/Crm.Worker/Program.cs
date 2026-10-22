using Crm.Audit;
using Crm.Catalog;
using Crm.Activities;
using Crm.Contracts;
using Crm.Billing;
using Crm.Notifications;
using Crm.Notifications.Features;
using Crm.Reports;
using Crm.Licensing;
using Crm.Privacy;
using Crm.Projects;
using Crm.Sales;
using Crm.Security;
using Crm.Service;
using Crm.TimeTracking;
using Crm.Contracts.Features;
using Crm.Sales.Features;
using Crm.Backup;
using Crm.CustomFields;
using Crm.Customers;
using Crm.Identity;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Health;
using Crm.Integrations.Brreg;
using Crm.Integrations.Core;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;
using Crm.Integrations.Atera;
using Crm.Integrations.CloudAlly;
using Microsoft.Extensions.Options;
using Crm.SharedKernel.Application;
using Crm.Worker;
using Hangfire;

if (args.Contains("--health-probe", StringComparer.Ordinal))
{
    Environment.Exit(await VpsHostConfiguration.HealthProbeAsync());
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.AddVpsConfiguration(args);

builder.AddServiceDefaults();

builder.Services.AddScoped<ICurrentUser, SystemCurrentUser>();
builder.Services
    .AddAuditModule(builder.Configuration)
    .AddIdentityModule(builder.Configuration)
    .AddCustomersModule(builder.Configuration)
    .AddCustomFieldsModule(builder.Configuration)
    .AddCatalogModule(builder.Configuration)
    .AddContractsModule(builder.Configuration)
    .AddServiceModule(builder.Configuration)
    // M40.S: Security fills with Huntress (M41); Backup holds CloudAlly's backups (M42).
    .AddSecurityModule(builder.Configuration)
    .AddBackupModule(builder.Configuration)
    .AddTimeTrackingModule(builder.Configuration)
    .AddSalesModule(builder.Configuration)
    .AddProjectsModule(builder.Configuration)
    .AddActivitiesModule(builder.Configuration)
    .AddLicensingModule(builder.Configuration)
    .AddBillingModule(builder.Configuration)
    .AddNotificationsModule(builder.Configuration)
    .AddReportsModule(builder.Configuration)
    .AddPrivacyModule(builder.Configuration)
    .AddBrregIntegration(builder.Configuration)
    .AddIntegrationsCore(builder.Configuration)
    .AddMicrosoftGraphIntegration(builder.Configuration)
    .AddPowerOfficeIntegration(builder.Configuration)
    .AddAteraIntegration(builder.Configuration)
    .AddCloudAllyIntegration(builder.Configuration)
    .AddPartnerCenterIntegration(builder.Configuration);

// DEV-06: the outbox loop with its liveness (rounds finish) and heartbeat; ready means the database answers.
builder.Services.AddOutboxProcessing();
// M39.1: vendor actions are sent every five seconds, with a heartbeat of their own.
builder.Services.AddVendorActionLoop();
builder.Services.AddDatabaseReadiness();
// DEV-17: reads operational state independently of Hangfire, so a stalled job server remains observable.
builder.Services.AddHostedService<OperationalTelemetry>();

builder.Services.AddHangfire(config => config
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString(ModuleRegistration.ConnectionStringName),
        new Hangfire.SqlServer.SqlServerStorageOptions
        {
            SchemaName = "hangfire",
            // The schema is installed by the migrator; locally the web host migrates on startup.
            PrepareSchemaIfNecessary = builder.Configuration.GetValue("Hangfire:PrepareSchema", false),
        }));
builder.Services.AddHangfireServer(options =>
{
    options.ServerName = $"crm-worker:{Environment.MachineName}";
    options.Queues = ["default"];
});

var app = builder.Build();

app.MapDefaultEndpoints();

// DEV-13: during read-only maintenance the worker performs only the jobs maintenance needs (privacy replay, heartbeat, audit check,
// Entra user and role syncs).
GlobalJobFilters.Filters.Add(new MaintenanceJobFilter(
    app.Services.GetRequiredService<Crm.SharedKernel.Operations.IMaintenanceGate>(), app.Services.GetRequiredService<ILogger<MaintenanceJobFilter>>()));

var oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");
var jobs = app.Services.GetRequiredService<IRecurringJobManager>();
jobs.AddOrUpdate<BrregRegistryCheckJob>(
    BrregRegistryCheckJob.JobId,
    job => job.RunAsync(CancellationToken.None),
    BrregRegistryCheckJob.Cron,
    new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<EntraUserSyncJob>(
    EntraUserSyncJob.JobId,
    job => job.RunAsync(CancellationToken.None),
    app.Services.GetRequiredService<IOptions<GraphOptions>>().Value.UserSyncCron,
    new RecurringJobOptions { TimeZone = oslo });
// DEV-10: the CRM roles of every user as Entra ID assigns them now (directly, through groups, PIM); sessions follow it.
jobs.AddOrUpdate<EntraRoleSyncJob>(
    EntraRoleSyncJob.JobId,
    job => job.RunAsync(CancellationToken.None),
    app.Services.GetRequiredService<IOptions<GraphOptions>>().Value.RoleSyncCron,
    new RecurringJobOptions { TimeZone = oslo });

// DEV-11: erasures lost by a database restore are applied again (and checked every few minutes, so a restore is caught even
// without a worker restart); the nightly retention job counts — and only with approved policies and Apply mode removes.
jobs.AddOrUpdate<Crm.Privacy.Features.PrivacyReplayJob>(
    Crm.Privacy.Features.PrivacyReplayJob.JobId, job => job.RunAsync(CancellationToken.None), "*/5 * * * *");
app.Services.GetRequiredService<IBackgroundJobClient>().Enqueue<Crm.Privacy.Features.PrivacyReplayJob>(job => job.RunAsync(CancellationToken.None));
jobs.AddOrUpdate<Crm.Privacy.Features.PrivacyRetentionJob>(
    Crm.Privacy.Features.PrivacyRetentionJob.JobId, job => job.RunAsync(CancellationToken.None),
    app.Services.GetRequiredService<IOptions<Crm.Privacy.Features.PrivacyOptions>>().Value.Retention.Cron,
    new RecurringJobOptions { TimeZone = oslo });

jobs.AddOrUpdate<ContractLifecycleJob>(ContractLifecycleJob.JobId, job => job.RunAsync(CancellationToken.None), "30 5 * * *", new RecurringJobOptions { TimeZone = oslo });
// DEV-04: the audit hash chain is extended and rechecked every night; checkpoints go to the log workspace as anchors.
jobs.AddOrUpdate<Crm.Audit.Features.AuditIntegrityJob>(Crm.Audit.Features.AuditIntegrityJob.JobId, job => job.RunAsync(CancellationToken.None), "40 4 * * *", new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<Crm.Audit.Features.AuditIntegrityJob>(Crm.Audit.Features.AuditIntegrityJob.FullJobId, job => job.VerifyAllAsync(CancellationToken.None), Cron.Never(), new RecurringJobOptions { TimeZone = oslo });
// DEV-14: the closed month's figures are kept once the month is over (daily; takes only what is missing).
jobs.AddOrUpdate<Crm.Reports.BiSnapshotJob>(Crm.Reports.BiSnapshotJob.JobId, job => job.RunAsync(CancellationToken.None), "10 5 * * *", new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<QuoteExpiryJob>(QuoteExpiryJob.JobId, job => job.RunAsync(CancellationToken.None), "0 6 * * *", new RecurringJobOptions { TimeZone = oslo });
// DEV-08: quote documents that storage could not take at release are stored as soon as it can; orphaned objects expire.
jobs.AddOrUpdate<QuoteDocumentJob>(QuoteDocumentJob.JobId, job => job.RunAsync(CancellationToken.None), "* * * * *");
jobs.AddOrUpdate<QuoteDocumentJob>(QuoteDocumentJob.OrphanJobId, job => job.CleanOrphansAsync(CancellationToken.None), "45 3 * * *", new RecurringJobOptions { TimeZone = oslo });

jobs.AddOrUpdate<OutboundProcessorJob>(OutboundProcessorJob.JobId, job => job.RunAsync(CancellationToken.None), "* * * * *");
// DEV-07: queued channel cards are sent apart from the events that queued them; delivered outbox rows and old receipts expire.
jobs.AddOrUpdate<ChannelPostJob>(ChannelPostJob.JobId, job => job.RunAsync(CancellationToken.None), "* * * * *");
jobs.AddOrUpdate<Crm.Infrastructure.Outbox.OutboxRetentionJob>(
    Crm.Infrastructure.Outbox.OutboxRetentionJob.JobId, job => job.RunAsync(CancellationToken.None), "15 3 * * *", new RecurringJobOptions { TimeZone = oslo });
// The job server's heartbeat: if jobs stop being executed, this ages (DEV-06).
jobs.AddOrUpdate<WorkerHeartbeatJob>(WorkerHeartbeatJob.JobId, job => job.RunAsync(CancellationToken.None), "* * * * *");

var powerOffice = app.Services.GetRequiredService<IOptions<PowerOfficeOptions>>().Value;
var billing = app.Services.GetRequiredService<IOptions<BillingOptions>>().Value;
var notifications = app.Services.GetRequiredService<IOptions<NotificationsOptions>>().Value;
jobs.AddOrUpdate<NotificationScanJob>(NotificationScanJob.JobId, job => job.RunAsync(CancellationToken.None), notifications.ScanCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<NotificationDigestJob>(NotificationDigestJob.JobId, job => job.RunAsync(CancellationToken.None), notifications.DigestCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PowerOfficeCustomerSyncJob>(PowerOfficeCustomerSyncJob.JobId, job => job.RunAsync(CancellationToken.None), powerOffice.CustomerSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PowerOfficeContactPersonSyncJob>(PowerOfficeContactPersonSyncJob.JobId, job => job.RunAsync(CancellationToken.None), powerOffice.ContactPersonSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PowerOfficeProductSyncJob>(PowerOfficeProductSyncJob.JobId, job => job.RunAsync(CancellationToken.None), powerOffice.ProductSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PowerOfficeInvoiceSyncJob>(PowerOfficeInvoiceSyncJob.JobId, job => job.RunAsync(CancellationToken.None), billing.InvoiceSyncCron, new RecurringJobOptions { TimeZone = oslo });

if (powerOffice.InvoicePdfSyncEnabled)
    jobs.AddOrUpdate<PowerOfficePdfSyncJob>(PowerOfficePdfSyncJob.JobId, job => job.RunAsync(CancellationToken.None), powerOffice.InvoicePdfSyncCron, new RecurringJobOptions { TimeZone = oslo });
else jobs.RemoveIfExists(PowerOfficePdfSyncJob.JobId);

if (powerOffice.CustomerLedgerSyncEnabled)
    jobs.AddOrUpdate<PowerOfficeLedgerSyncJob>(PowerOfficeLedgerSyncJob.JobId, job => job.RunAsync(CancellationToken.None), powerOffice.CustomerLedgerSyncCron, new RecurringJobOptions { TimeZone = oslo });

var partnerCenter = app.Services.GetRequiredService<IOptions<PartnerCenterOptions>>().Value;
jobs.AddOrUpdate<PartnerCenterCustomerSyncJob>(PartnerCenterCustomerSyncJob.JobId, job => job.RunAsync(CancellationToken.None), partnerCenter.CustomerSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PartnerCenterSubscriptionSyncJob>(PartnerCenterSubscriptionSyncJob.JobId, job => job.RunAsync(CancellationToken.None), partnerCenter.SubscriptionSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PartnerCenterLicenseSyncJob>(PartnerCenterLicenseSyncJob.JobId, job => job.RunAsync(CancellationToken.None), partnerCenter.LicenseSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<PartnerBillingSyncJob>(PartnerBillingSyncJob.JobId, job => job.RunAsync(CancellationToken.None), partnerCenter.BillingSyncCron, new RecurringJobOptions { TimeZone = oslo });

var atera = app.Services.GetRequiredService<IOptions<AteraOptions>>().Value;
jobs.AddOrUpdate<AteraCustomerSyncJob>(AteraCustomerSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.CustomerSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraContactSyncJob>(AteraContactSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.ContactSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraTicketSyncJob>(AteraTicketSyncJob.OpenJobId, job => job.RunAsync(false, CancellationToken.None), atera.TicketSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraTicketSyncJob>(AteraTicketSyncJob.RecentJobId, job => job.RunAsync(true, CancellationToken.None), atera.RecentTicketSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraTicketConversationSyncJob>(AteraTicketConversationSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.TicketConversationSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraWorkHoursSyncJob>(AteraWorkHoursSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.WorkHoursSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraAgentSyncJob>(AteraAgentSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.AgentSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraPatchSyncJob>(AteraPatchSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.PatchSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<AteraAlertSyncJob>(AteraAlertSyncJob.JobId, job => job.RunAsync(CancellationToken.None), atera.AlertSyncCron, new RecurringJobOptions { TimeZone = oslo });

// M42: CloudAlly's accounts (for the mapping), the backups with the coverage check after a complete read, and the bills.
var cloudAlly = app.Services.GetRequiredService<IOptions<CloudAllyOptions>>().Value;
jobs.AddOrUpdate<CloudAllyAccountSyncJob>(CloudAllyAccountSyncJob.JobId, job => job.RunAsync(CancellationToken.None), cloudAlly.AccountSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<CloudAllyBackupSyncJob>(CloudAllyBackupSyncJob.JobId, job => job.RunAsync(CancellationToken.None), cloudAlly.BackupSyncCron, new RecurringJobOptions { TimeZone = oslo });
jobs.AddOrUpdate<CloudAllyBillSyncJob>(CloudAllyBillSyncJob.JobId, job => job.RunAsync(CancellationToken.None), cloudAlly.BillSyncCron, new RecurringJobOptions { TimeZone = oslo });

await app.RunAsync();
