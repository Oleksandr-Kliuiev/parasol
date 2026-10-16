using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Server-only credentials, keyed by immutable CRM employee ID. Never a shared all-customers actor.</summary>
public sealed class AtlasWorkspaceOptions
{
    public const string Section = "Parasol:Atlas";
    public bool Enabled { get; set; }
    public string BaseUrl { get; set; } = string.Empty;
    // ConfigurationBinder supports string dictionary keys. Validate canonical UUIDs explicitly at startup.
    public Dictionary<string, AtlasEmployeeCredential> Employees { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    internal bool IsValid()
    {
        if (!Enabled) return true;
        return Uri.TryCreate(BaseUrl, UriKind.Absolute, out var uri)
            && (uri.Scheme == "https" || (uri.Scheme == "http" && uri.IsLoopback))
            && uri.AbsolutePath == "/" && uri.Query.Length == 0 && uri.Fragment.Length == 0 && uri.UserInfo.Length == 0
            && Employees.All(e => Guid.TryParseExact(e.Key, "D", out var id) && id != Guid.Empty && e.Value is not null
                && Regex.IsMatch(e.Value.WorkspaceId, @"\A[A-Za-z0-9._:-]{1,128}\z", RegexOptions.CultureInvariant)
                && Regex.IsMatch(e.Value.Token, @"\A[A-Za-z0-9\-._~+/]{20,256}={0,2}\z", RegexOptions.CultureInvariant))
            && Employees.Values.Select(e => e.Token).Distinct(StringComparer.Ordinal).Count() == Employees.Count;
    }
}

public sealed class AtlasEmployeeCredential
{
    public string WorkspaceId { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
}

internal static class AtlasWorkspaceRegistration
{
    internal const string ClientName = "Parasol.Atlas";
    public static void AddAtlasWorkspace(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<AtlasWorkspaceOptions>().Bind(configuration.GetSection(AtlasWorkspaceOptions.Section))
            .Validate(o => o.IsValid(), "Parasol Atlas requires an HTTPS origin (HTTP only on loopback) and distinct employee credentials with workspace IDs.")
            .ValidateOnStart();
        services.AddHttpClient(ClientName, client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
            .RemoveAllLoggers(); // No customer paths, headers or upstream bodies in HttpClient logs.
        services.AddScoped<AtlasWorkspaceReader>();
        services.AddScoped<AtlasReadClient>();
        services.AddScoped<AtlasIdentityReader>();
    }
}
