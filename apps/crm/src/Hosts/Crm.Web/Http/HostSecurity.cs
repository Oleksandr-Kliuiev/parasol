using System.Net;
using Microsoft.AspNetCore.HttpOverrides;

namespace Crm.Web.Http;

/// <summary>
/// Which hosts and which proxies the application believes (ASVS 3.x / 12): <c>X-Forwarded-*</c> is honoured only from a known
/// proxy, <c>X-Forwarded-Host</c> only for an allowed host, and Production refuses to start with <c>AllowedHosts</c> open.
/// </summary>
internal static class HostSecurity
{
    /// <summary>
    /// The private ranges: where Azure Container Apps' ingress and a VNet-internal peer live. It is the default outside
    /// development so that the scheme and client address are right behind the ingress; <c>Forwarded:KnownNetworks</c> narrows it
    /// to the apps subnet, which is the recommended production setting.
    /// </summary>
    internal static readonly string[] PrivateNetworks = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fd00::/8"];

    public static void ConfigureForwardedHeaders(ForwardedHeadersOptions options, IConfiguration configuration, IHostEnvironment environment)
    {
        options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
        var networks = configuration.GetSection("Forwarded:KnownNetworks").Get<string[]>() ?? [];
        var proxies = configuration.GetSection("Forwarded:KnownProxies").Get<string[]>() ?? [];
        if (networks.Length == 0 && proxies.Length == 0 && !environment.IsDevelopment() && !environment.IsEnvironment("Testing"))
        {
            networks = PrivateNetworks;
        }

        // Development and tests keep the framework's default: only a proxy on the loopback address is believed.
        foreach (var network in networks.Where(n => !string.IsNullOrWhiteSpace(n)))
        {
            if (!System.Net.IPNetwork.TryParse(network.Trim(), out var parsed))
            {
                throw new InvalidOperationException($"Forwarded:KnownNetworks: '{network}' is not a network in CIDR notation (for example 10.40.0.0/23).");
            }

            options.KnownIPNetworks.Add(parsed);
        }

        foreach (var proxy in proxies.Where(p => !string.IsNullOrWhiteSpace(p)))
        {
            if (!IPAddress.TryParse(proxy.Trim(), out var address))
            {
                throw new InvalidOperationException($"Forwarded:KnownProxies: '{proxy}' is not an IP address.");
            }

            options.KnownProxies.Add(address);
        }

        // The forwarded host must be one the application serves, whoever sent it.
        foreach (var host in AllowedHostNames(configuration["AllowedHosts"]))
        {
            options.AllowedHosts.Add(host);
        }
    }

    internal static IReadOnlyList<string> AllowedHostNames(string? allowedHosts) =>
        (allowedHosts ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(h => h != "*").ToList();

    /// <summary>Production names its hosts: the host the OIDC redirect address is built from is not whatever a request claims.</summary>
    internal static string? AllowedHostsProblem(string? allowedHosts, IHostEnvironment environment) =>
        environment.IsProduction() && (AllowedHostNames(allowedHosts).Count == 0 || (allowedHosts ?? string.Empty).Split(';').Any(h => h.Trim() == "*"))
            ? "Production needs AllowedHosts set to the host names the application serves (semicolon separated, not '*')."
            : null;
}
