using Crm.Integrations.Atera;
using Crm.Integrations.Brreg;
using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core.Readiness;
using Crm.Integrations.Huntress;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;
using Microsoft.Extensions.Options;

namespace Crm.Web;

/// <summary>
/// The integrations and the recurring jobs that read them, as Crm.Worker/Program.cs registers the jobs, with this instance's
/// switches. Web-instance switches only: worker credentials and provider availability are deliberately not inspected.
/// </summary>
internal sealed class ConnectionCatalog(
    IOptions<AteraOptions> atera, IOptions<HuntressOptions> huntress, IOptions<PowerOfficeOptions> powerOffice, IOptions<PartnerCenterOptions> partnerCenter,
    IOptions<GraphOptions> graph, IOptions<CloudAllyOptions> cloudAlly) : IConnectionCatalog
{
    public IReadOnlyList<ConnectionDefinition> Read()
    {
        var office = powerOffice.Value;
        var partner = partnerCenter.Value;
        return
        [
            // M44: the two vendors whose webhooks start reads early; the switch only (crm-web refuses to start without the secret).
            new(AteraTypes.System, atera.Value.Enabled, atera.Value.WriteEnabled,
            [
                AteraCustomerSyncJob.JobId, AteraContactSyncJob.JobId, AteraTicketSyncJob.OpenJobId, AteraTicketSyncJob.RecentJobId,
                AteraWorkHoursSyncJob.JobId, AteraAgentSyncJob.JobId, AteraPatchSyncJob.JobId, AteraAlertSyncJob.JobId, AteraTicketConversationSyncJob.JobId,
            ], atera.Value.Enabled && atera.Value.WebhookEnabled),
            new(HuntressTypes.System, huntress.Value.Enabled, huntress.Value.WriteEnabled,
            [
                HuntressOrganizationSyncJob.JobId, HuntressAgentSyncJob.JobId, HuntressAlertSyncJob.JobId, HuntressReportSyncJob.JobId,
                HuntressReportFileJob.JobId,
            ], huntress.Value.Enabled && huntress.Value.WebhookEnabled),
            new(PowerOfficeTypes.System, office.Enabled, office.WriteEnabled,
            [
                PowerOfficeCustomerSyncJob.JobId, PowerOfficeContactPersonSyncJob.JobId, PowerOfficeProductSyncJob.JobId, PowerOfficeInvoiceSyncJob.JobId,
                // The worker schedules these two only when they are switched on.
                .. office.InvoicePdfSyncEnabled ? [PowerOfficePdfSyncJob.JobId] : Array.Empty<string>(),
                .. office.CustomerLedgerSyncEnabled ? [PowerOfficeLedgerSyncJob.JobId] : Array.Empty<string>(),
            ]),
            new(CloudAllyTypes.System, cloudAlly.Value.Enabled, cloudAlly.Value.WriteEnabled,
                [CloudAllyAccountSyncJob.JobId, CloudAllyBackupSyncJob.JobId, CloudAllyBillSyncJob.JobId]),
            // Partner Center and the directory are only read; the billing reconciliation runs when it is switched on.
            new(PartnerCenterTypes.System, partner.Enabled, null,
            [
                PartnerCenterCustomerSyncJob.JobId, PartnerCenterSubscriptionSyncJob.JobId, PartnerCenterLicenseSyncJob.JobId,
                .. partner.BillingReconciliationEnabled ? [PartnerBillingSyncJob.JobId] : Array.Empty<string>(),
            ]),
            new(EntraUserSyncJob.System, graph.Value.Enabled, null, [EntraUserSyncJob.JobId, EntraRoleSyncJob.JobId]),
            // The open register has no switch: it is always read.
            new(BrregRegistryCheckJob.System, true, null, [BrregRegistryCheckJob.JobId]),
        ];
    }
}
