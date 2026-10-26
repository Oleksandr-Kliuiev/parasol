using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Azure.Core;
using Crm.Integrations.Core;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

public sealed class GraphOptions
{
    public const string SectionName = "Integrations:MicrosoftGraph";

    /// <summary>Off by default so local development and tests do not call Microsoft Graph.</summary>
    public bool Enabled { get; set; }

    /// <summary>The company's Entra tenant; users from delta queries belong to it.</summary>
    public string? TenantId { get; set; }

    public Uri BaseUrl { get; set; } = new("https://graph.microsoft.com/v1.0/");

    public string? ClientId { get; set; }

    public string? CertificatePath { get; set; }

    public string? CertificatePassword { get; set; }

    /// <summary>Retained only to reject obsolete Azure deployment configuration.</summary>
    public string? ManagedIdentityClientId { get; set; }

    public string UserSyncCron { get; set; } = "15 * * * *";

    /// <summary>
    /// Client id of the CRM's own app registration (DEV-10): the role sync reads who is assigned to its app roles. Needs the
    /// Graph application permissions Application.Read.All and GroupMember.Read.All on the worker's identity (runbook 12).
    /// </summary>
    public string? CrmAppId { get; set; }

    /// <summary>Every two minutes: with the session cache this bounds the revocation of a privilege at about two and a half minutes.</summary>
    public string RoleSyncCron { get; set; } = "*/2 * * * *";

    /// <summary>Meetings are pushed to the organizer's Outlook calendar (FR-ACT-02).</summary>
    public bool CalendarEnabled { get; set; }

    /// <summary>The customer card may read the signed-in user's mailbox (FR-ACT-03).</summary>
    public bool MailEnabled { get; set; }

    /// <summary>Shared mailboxes (support@, salg@) that are searched in addition to the user's own, when they may open them.</summary>
    public IList<string> SharedMailboxes { get; } = [];

    public GraphSharePointOptions SharePoint { get; set; } = new();

    public GraphTeamsOptions Teams { get; set; } = new();

    /// <summary>Startup check (F-G4-16): the Graph address is https and every Teams webhook is https on an allowed host.</summary>
    internal bool IsValid(out string problem)
    {
        if (!Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(BaseUrl))
        {
            problem = "Integrations:MicrosoftGraph:BaseUrl must be an https address.";
            return false;
        }

        foreach (var (channel, value) in Teams.Channels)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (!Uri.TryCreate(value, UriKind.Absolute, out var url) || !Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(url)
                || (!url.IsLoopback && !Crm.SharedKernel.Text.WebUrl.HostMatches(url, Teams.AllowedHostSuffixes)))
            {
                // The setting name only: the URL carries its own secret.
                problem = $"Integrations:MicrosoftGraph:Teams:Channels:{channel} must be an https address on one of Teams:AllowedHostSuffixes.";
                return false;
            }
        }

        problem = string.Empty;
        return true;
    }
}

public sealed record GraphUser(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("displayName")] string? DisplayName,
    [property: JsonPropertyName("userPrincipalName")] string? UserPrincipalName,
    [property: JsonPropertyName("mail")] string? Mail,
    [property: JsonPropertyName("department")] string? Department,
    [property: JsonPropertyName("jobTitle")] string? JobTitle,
    [property: JsonPropertyName("accountEnabled")] bool? AccountEnabled,
    [property: JsonPropertyName("@removed")] GraphRemoved? Removed);

public sealed record GraphRemoved([property: JsonPropertyName("reason")] string? Reason);

internal sealed record GraphDeltaPage(
    [property: JsonPropertyName("value")] IReadOnlyList<GraphUser> Value,
    [property: JsonPropertyName("@odata.nextLink")] string? NextLink,
    [property: JsonPropertyName("@odata.deltaLink")] string? DeltaLink);

public sealed record GraphDeltaResult(IReadOnlyList<GraphUser> Users, string DeltaLink);

/// <summary>The stored delta token is no longer accepted; a full synchronization is required.</summary>
public sealed class DeltaTokenExpiredException() : Exception("The Graph delta token has expired.");

public interface IGraphUserSource
{
    /// <summary>Follows nextLink pages until Graph returns a deltaLink. A null link starts a full enumeration.</summary>
    Task<GraphDeltaResult> GetUserChangesAsync(string? deltaLink, CancellationToken cancellationToken);
}

internal sealed class GraphUserSource(HttpClient http) : IGraphUserSource
{
    private const string InitialQuery = "users/delta?$select=id,displayName,userPrincipalName,mail,department,jobTitle,accountEnabled";

    public async Task<GraphDeltaResult> GetUserChangesAsync(string? deltaLink, CancellationToken cancellationToken)
    {
        var users = new List<GraphUser>();
        // A stored cursor that does not belong to this Graph address is treated like an expired one: the sync starts over.
        if (deltaLink is not null && !GraphLinks.IsSameOrigin(http.BaseAddress, deltaLink))
        {
            throw new DeltaTokenExpiredException();
        }

        var url = deltaLink ?? InitialQuery;
        for (int page = 0; page < 1000; page++)
        {
            using var response = await http.GetAsync(url, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Gone)
            {
                throw new DeltaTokenExpiredException();
            }

            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadFromJsonAsync<GraphDeltaPage>(cancellationToken)
                       ?? throw new InvalidOperationException("Empty delta page from Microsoft Graph.");
            users.AddRange(body.Value);
            if (body.DeltaLink is not null)
            {
                return new GraphDeltaResult(users, GraphLinks.Require(http.BaseAddress, body.DeltaLink));
            }

            url = GraphLinks.Require(
                http.BaseAddress, body.NextLink ?? throw new InvalidOperationException("Delta page has neither nextLink nor deltaLink."));
        }

        throw new InvalidOperationException("Too many delta pages.");
    }
}

/// <summary>Adds an app-only Graph token from the managed identity to every request.</summary>
internal sealed class GraphAuthenticationHandler(TokenCredential credential, IOptions<GraphOptions> options) : DelegatingHandler
{
    private static readonly TokenRequestContext Scope = new(["https://graph.microsoft.com/.default"]);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // The token is never attached to a request for another host (F-G5-12).
        if (!GraphLinks.IsSameOrigin(options.Value.BaseUrl, request.RequestUri))
        {
            throw new InvalidOperationException("A request outside the configured Graph address was refused before a token was attached.");
        }

        var token = await credential.GetTokenAsync(Scope, cancellationToken);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await base.SendAsync(request, cancellationToken);
    }
}
