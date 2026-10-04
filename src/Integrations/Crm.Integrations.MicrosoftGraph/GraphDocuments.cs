using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// One SharePoint folder per customer in the library "Dokumenter" (FR-DOC-01). The folder is created when the
/// organization becomes a customer, renamed when the organization is renamed, and linked through
/// <c>integration.ExternalLink</c> so the name in SharePoint may be changed by hand without losing the connection. Creating
/// and renaming ask the maintenance switch first (DEV-13); they are not journaled, because both are idempotent by name — a
/// database restored to before the folder adopts the folder that is there instead of making a second one.
/// </summary>
internal sealed class GraphDocuments(
    HttpClient http,
    ICustomersApi customers,
    ExternalLinkService links,
    ICurrentUser currentUser,
    IMaintenanceGate maintenance,
    IOptions<GraphOptions> options,
    ILogger<GraphDocuments> logger) : IDocumentLibrary
{
    public const string System = "graph";
    public const string FolderType = "Folder";

    private GraphSharePointOptions Settings => options.Value.SharePoint;

    public bool IsAvailable => options.Value.Enabled && Settings.Enabled && !string.IsNullOrWhiteSpace(Settings.SiteId);

    public async Task<DocumentFolder?> GetFolderAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (!IsAvailable)
        {
            return null;
        }

        if (await links.FindByEntityAsync(EntityTypes.Organization, organizationId, System, FolderType, cancellationToken) is not { } link)
        {
            return null;
        }

        var driveId = await DriveIdAsync(cancellationToken);
        using var response = await http.GetAsync($"drives/{driveId}/items/{link.ExternalId}", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            logger.LogWarning("The SharePoint folder of organization {Organization} no longer exists.", organizationId);
            return null;
        }

        var item = await ReadAsync<GraphDriveItem>(response, cancellationToken);
        return new DocumentFolder(item.Id, item.Name ?? string.Empty, item.WebUrl ?? string.Empty);
    }

    public async Task<DocumentFolder> EnsureFolderAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (!IsAvailable)
        {
            throw new InvalidOperationException("SharePoint is not configured.");
        }

        if (await GetFolderAsync(organizationId, cancellationToken) is { } existing)
        {
            return existing;
        }

        var organization = await customers.GetOrganizationAsync(organizationId, cancellationToken)
                           ?? throw new InvalidOperationException($"Organization {organizationId} was not found.");
        var driveId = await DriveIdAsync(cancellationToken);
        var name = FolderName(organization.Name, organization.OrgNumber);
        await maintenance.EnsureMaySendAsync(cancellationToken);

        // "replace" would overwrite a folder somebody made by hand; the existing one is adopted instead.
        using var created = await http.PostAsJsonAsync(
            $"drives/{driveId}/root/children",
            new Dictionary<string, object?>
            {
                ["name"] = name,
                ["folder"] = new { },
                ["@microsoft.graph.conflictBehavior"] = "fail",
            },
            cancellationToken);

        GraphDriveItem item;
        if (created.StatusCode == HttpStatusCode.Conflict)
        {
            using var found = await http.GetAsync($"drives/{driveId}/root:/{Uri.EscapeDataString(name)}", cancellationToken);
            item = await ReadAsync<GraphDriveItem>(found, cancellationToken);
        }
        else
        {
            item = await ReadAsync<GraphDriveItem>(created, cancellationToken);
        }

        await links.LinkAsync(EntityTypes.Organization, organizationId, System, FolderType, item.Id, LinkMethod.Automatic, currentUser.UserId, cancellationToken);
        return new DocumentFolder(item.Id, item.Name ?? name, item.WebUrl ?? string.Empty);
    }

    public async Task<IReadOnlyList<DocumentItem>> ListAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (await GetFolderAsync(organizationId, cancellationToken) is not { } folder)
        {
            return [];
        }

        var driveId = await DriveIdAsync(cancellationToken);
        using var response = await http.GetAsync(
            $"drives/{driveId}/items/{folder.FolderId}/children?$select=id,name,size,folder,webUrl,lastModifiedDateTime,lastModifiedBy&$top=200",
            cancellationToken);
        var page = await ReadAsync<GraphDriveItemPage>(response, cancellationToken);
        return page.Value
            .Select(item => new DocumentItem(
                item.Id,
                item.Name ?? string.Empty,
                item.Folder is not null,
                item.Folder is null ? item.Size : null,
                item.LastModifiedDateTime,
                item.LastModifiedBy?.User?.DisplayName,
                item.WebUrl ?? string.Empty))
            .OrderByDescending(item => item.IsFolder)
            .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>Renames the folder after the organization; SharePoint keeps the item id, so links survive.</summary>
    public async Task RenameFolderAsync(Guid organizationId, string organizationName, string? orgNumber, CancellationToken cancellationToken)
    {
        if (await GetFolderAsync(organizationId, cancellationToken) is not { } folder)
        {
            return;
        }

        var name = FolderName(organizationName, orgNumber);
        if (string.Equals(folder.Name, name, StringComparison.Ordinal))
        {
            return;
        }

        var driveId = await DriveIdAsync(cancellationToken);
        await maintenance.EnsureMaySendAsync(cancellationToken);
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"drives/{driveId}/items/{folder.FolderId}")
        {
            Content = JsonContent.Create(new { name }),
        };
        using var response = await http.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            logger.LogWarning("Renaming the SharePoint folder of {Organization} failed with {Status}.", organizationId, (int)response.StatusCode);
        }
    }

    /// <summary>"Åsane Rør AS (912345678)" — the org number keeps two customers with the same name apart.</summary>
    internal static string FolderName(string organizationName, string? orgNumber)
    {
        var cleaned = new string(organizationName.Select(c => "\"*:<>?/\\|".Contains(c, StringComparison.Ordinal) ? '-' : c).ToArray()).Trim();
        var name = string.IsNullOrWhiteSpace(orgNumber) ? cleaned : $"{cleaned} ({orgNumber})";
        return name.Length > 120 ? name[..120].TrimEnd() : name;
    }

    private string? _driveId;

    private async Task<string> DriveIdAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(Settings.DriveId))
        {
            return Settings.DriveId;
        }

        if (_driveId is not null)
        {
            return _driveId;
        }

        using var response = await http.GetAsync($"sites/{Settings.SiteId}/drives?$select=id,name", cancellationToken);
        var page = await ReadAsync<GraphDrivePage>(response, cancellationToken);
        var drive = page.Value.FirstOrDefault(d => string.Equals(d.Name, Settings.DriveName, StringComparison.OrdinalIgnoreCase))
                    ?? (page.Value.Count > 0 ? page.Value[0] : null)
                    ?? throw new InvalidOperationException($"SharePoint site {Settings.SiteId} has no document library.");
        _driveId = drive.Id;
        return drive.Id;
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"Graph SharePoint returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
        }

        return await response.Content.ReadFromJsonAsync<T>(cancellationToken)
               ?? throw new HttpRequestException("Graph returned an empty document response.");
    }
}

public sealed record GraphIdentity([property: JsonPropertyName("displayName")] string? DisplayName);

public sealed record GraphIdentitySet([property: JsonPropertyName("user")] GraphIdentity? User);

public sealed record GraphFolderFacet([property: JsonPropertyName("childCount")] int? ChildCount);

public sealed record GraphDriveItem(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("size")] long? Size,
    [property: JsonPropertyName("webUrl")] string? WebUrl,
    [property: JsonPropertyName("folder")] GraphFolderFacet? Folder,
    [property: JsonPropertyName("lastModifiedDateTime")] DateTimeOffset? LastModifiedDateTime,
    [property: JsonPropertyName("lastModifiedBy")] GraphIdentitySet? LastModifiedBy);

internal sealed record GraphDriveItemPage([property: JsonPropertyName("value")] IReadOnlyList<GraphDriveItem> Value);

internal sealed record GraphDrive([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string? Name);

internal sealed record GraphDrivePage([property: JsonPropertyName("value")] IReadOnlyList<GraphDrive> Value);
