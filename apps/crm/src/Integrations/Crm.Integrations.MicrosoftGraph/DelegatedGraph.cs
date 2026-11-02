using System.Net.Http.Headers;
using Crm.Integrations.Core;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Hands out an access token for the signed-in user. Implemented by the web host (which owns the OIDC session and the
/// token cache); in the worker and under the development sign-in there is none, and features that need it stay off.
/// </summary>
public interface IDelegatedTokenSource
{
    /// <summary>Null when there is no signed-in user, no delegated token, or consent for the scopes is missing.</summary>
    Task<string?> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken cancellationToken);
}

/// <summary>Without a host implementation (worker, tests without a session) delegated calls are simply unavailable.</summary>
internal sealed class NoDelegatedToken : IDelegatedTokenSource
{
    public Task<string?> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken cancellationToken) => Task.FromResult<string?>(null);
}

/// <summary>
/// Puts the signed-in person's token on a request, for the scopes of one feature: each feature asks only for its own, so consent missing
/// for one (the files, M47) never switches off another (the calendar).
/// </summary>
internal abstract class DelegatedAuthenticationHandler(
    IDelegatedTokenSource tokens, Microsoft.Extensions.Options.IOptions<GraphOptions> options, IReadOnlyList<string> scopes) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (!GraphLinks.IsSameOrigin(options.Value.BaseUrl, request.RequestUri))
        {
            throw new InvalidOperationException("A request outside the configured Graph address was refused before a token was attached.");
        }

        var token = await tokens.GetTokenAsync(scopes, cancellationToken)
                    ?? throw new Crm.Activities.Contracts.UserNotConnectedException("Microsoft Graph");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return await base.SendAsync(request, cancellationToken);
    }
}

/// <summary>The calendar and the mailbox (S10).</summary>
internal sealed class GraphDelegatedAuthenticationHandler(IDelegatedTokenSource tokens, Microsoft.Extensions.Options.IOptions<GraphOptions> options)
    : DelegatedAuthenticationHandler(tokens, options, Scopes)
{
    /// <summary>Scopes the delegated features need; consent is granted once for the application (docs/05 §1.3).</summary>
    public static readonly string[] Scopes = ["Calendars.ReadWrite", "Mail.Read"];
}

/// <summary>The customers' folders, read as the person who looks at them (M47): what they may not open in SharePoint, the card does not show.</summary>
internal sealed class GraphFilesAuthenticationHandler(IDelegatedTokenSource tokens, Microsoft.Extensions.Options.IOptions<GraphOptions> options)
    : DelegatedAuthenticationHandler(tokens, options, Scopes)
{
    public static readonly string[] Scopes = ["Files.Read.All"];
}

/// <summary>Settings of the SharePoint library that holds a folder per customer (FR-DOC-01, M47).</summary>
public sealed class GraphSharePointOptions
{
    public bool Enabled { get; set; }

    /// <summary>Site id as Graph reports it, e.g. <c>contoso.sharepoint.com,&lt;siteGuid&gt;,&lt;webGuid&gt;</c>.</summary>
    public string? SiteId { get; set; }

    /// <summary>Drive (document library) id; when empty the library is looked up by <see cref="DriveName"/>.</summary>
    public string? DriveId { get; set; }

    public string DriveName { get; set; } = "Dokumenter";

    /// <summary>
    /// The folder inside the library that holds the customers' folders, e.g. <c>Kunder</c> (M47); empty is the library itself. The mapping
    /// screen lists its folders, and a new customer folder is created there.
    /// </summary>
    public string? RootFolder { get; set; }

    /// <summary>Folders of the root folder for the mapping screen (<c>sharepoint-folders</c>), once an hour.</summary>
    public string FolderSyncCron { get; set; } = "40 * * * *";

    /// <summary>Creating and renaming folders (M39.1 switches): off until switched on, like every vendor's writes.</summary>
    public bool WriteEnabled { get; set; }

    /// <summary>The worker reads SharePoint and says what it would do, without creating or renaming anything.</summary>
    public bool DryRun { get; set; }

    /// <summary>CRM organization ids a folder may be created for; empty = every customer.</summary>
    public IList<string> WriteAllowedCustomerIds { get; } = [];

    /// <summary>The action kinds that are switched on (<see cref="SharePointActionKinds"/>); a kind not listed is refused.</summary>
    public IList<string> EnabledActions { get; } = [];
}

/// <summary>Workflows webhooks for the team's channels (FR-ACT-04).</summary>
public sealed class GraphTeamsOptions
{
    public bool Enabled { get; set; }

    /// <summary>A won deal is announced in the sales channel from this amount (weighted value excluded).</summary>
    public decimal WonDealThreshold { get; set; } = 100_000m;

    /// <summary>Webhook URL per channel: Sales, Finance, Operations.</summary>
    public IDictionary<string, string> Channels { get; } = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// A webhook URL must be https on one of these hosts (or a subdomain): Power Automate Workflows and the retired Office 365
    /// connector domains. Add a suffix here when Microsoft moves the service; a URL anywhere else is refused at startup.
    /// </summary>
    public IList<string> AllowedHostSuffixes { get; } = ["logic.azure.com", "powerplatform.com", "webhook.office.com", "office.com"];
}
