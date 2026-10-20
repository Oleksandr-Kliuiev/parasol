using Crm.Integrations.Atera;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PowerOffice;
using Crm.Web.Auth;
using Microsoft.Extensions.Options;

namespace Crm.Web;

/// <summary>Web-instance switches only. Worker credentials and provider availability are deliberately not inspected.</summary>
// AuthenticationSetup binds this singleton directly; IOptions<CrmAuthOptions> would be an unrelated default instance.
internal sealed class LocalReadinessFlagsReader(CrmAuthOptions auth, IOptions<AteraOptions> atera,
    IOptions<PowerOfficeOptions> powerOffice, IOptions<GraphOptions> graph) : ILocalReadinessFlags
{
    public LocalReadinessFlags Read() => new(auth.Mode == AuthMode.Entra ? "ENTRA" : "DEVELOPMENT",
        atera.Value.Enabled, atera.Value.WriteEnabled, powerOffice.Value.Enabled, powerOffice.Value.WriteEnabled,
        graph.Value.Enabled, graph.Value.CalendarEnabled, graph.Value.MailEnabled, graph.Value.SharePoint.Enabled, graph.Value.Teams.Enabled);
}
