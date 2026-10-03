using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Azure.Core;

namespace Crm.Integrations.MicrosoftGraph;

public sealed class GraphOptions
{
    public const string SectionName = "Integrations:MicrosoftGraph";

    /// <summary>Off by default so local development and tests do not call Microsoft Graph.</summary>
    public bool Enabled { get; set; }

    /// <summary>The company's Entra tenant; users from delta queries belong to it.</summary>
    public string? TenantId { get; set; }

    public Uri BaseUrl { get; set; } = new("https://graph.microsoft.com/v1.0/");

    /// <summary>Client id of the user-assigned managed identity that holds the Graph <c>User.Read.All</c> app role.</summary>
    public string? ManagedIdentityClientId { get; set; }

    public string UserSyncCron { get; set; } = "15 * * * *";

    /// <summary>Meetings are pushed to the organizer's Outlook calendar (FR-ACT-02).</summary>
    public bool CalendarEnabled { get; set; }

    /// <summary>The customer card may read the signed-in user's mailbox (FR-ACT-03).</summary>
    public bool MailEnabled { get; set; }

    /// <summary>Shared mailboxes (support@, salg@) that are searched in addition to the user's own, when they may open them.</summary>
    public IList<string> SharedMailboxes { get; } = [];

    public GraphSharePointOptions SharePoint { get; set; } = new();

    public GraphTeamsOptions Teams { get; set; } = new();
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
                return new GraphDeltaResult(users, body.DeltaLink);
            }

            url = body.NextLink ?? throw new InvalidOperationException("Delta page has neither nextLink nor deltaLink.");
        }

        throw new InvalidOperationException("Too many delta pages.");
    }
}

/// <summary>Adds an app-only Graph token from the managed identity to every request.</summary>
internal sealed class GraphAuthenticationHandler(TokenCredential credential) : DelegatingHandler
{
    private static readonly TokenRequestContext Scope = new(["https://graph.microsoft.com/.default"]);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var token = await credential.GetTokenAsync(Scope, cancellationToken);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        return await base.SendAsync(request, cancellationToken);
    }
}
