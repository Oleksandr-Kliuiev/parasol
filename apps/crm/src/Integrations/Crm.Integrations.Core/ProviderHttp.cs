namespace Crm.Integrations.Core;

/// <summary>
/// The primary handler of every provider client (Atera, PowerOffice, Partner Center, Huntress, CloudAlly) and of the Brreg
/// register client. A provider client never follows a redirect: the repeated request would carry its key or token to whatever
/// address the answer names — <c>Authorization</c> is dropped on a redirect, but <c>X-API-KEY</c> and
/// <c>Ocp-Apim-Subscription-Key</c> are not. The register's open API takes no key, but its answer must not send the CRM to
/// another address either. A 3xx is then an answer like any other error.
/// </summary>
public static class ProviderHttp
{
    public static HttpMessageHandler NoRedirects() => new SocketsHttpHandler { AllowAutoRedirect = false };
}
