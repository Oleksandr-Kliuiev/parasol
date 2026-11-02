using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;
using Crm.Integrations.Core;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// The customer folders in SharePoint on the application identity (<c>Sites.Selected</c>, M47): crm-worker reads the folders of the
/// root folder for the mapping screen, creates a customer's folder when a person asks for it, and renames a folder the CRM made. The
/// root folder (<c>SharePoint:RootFolder</c>, e.g. "Kunder") is where the customers' folders live inside the library. A failed call
/// throws an <see cref="HttpRequestException"/> with the status and never the answer's text, which may name a customer.
/// </summary>
public sealed class SharePointClient(HttpClient http, IOptions<GraphOptions> options, SharePointDrive drive)
{
    private GraphSharePointOptions Settings => options.Value.SharePoint;

    /// <summary>The folders directly in the root folder, page by page; files beside them are left out.</summary>
    public async IAsyncEnumerable<GraphDriveItem> ListFoldersAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        string? address = SharePointNames.ItemAddress(driveId, Settings.RootFolder, suffix: "/children") +
                          "?$select=id,name,webUrl,folder,lastModifiedDateTime&$top=200";
        while (address is not null)
        {
            using var response = await http.GetAsync(address, cancellationToken);
            var page = await SharePointHttp.ReadAsync<GraphDriveItemPage>(response, cancellationToken);
            foreach (var item in page.Value.Where(i => i.Folder is not null))
            {
                yield return item;
            }

            // The next page is followed only at the configured Graph address: the token never goes elsewhere (F-G5-12). A next page that
            // cannot be followed fails the read: a listing cut short would mark the folders it never reached as gone.
            if (page.NextLink is not { } next)
            {
                address = null;
            }
            else if (GraphLinks.IsSameOrigin(options.Value.BaseUrl, new Uri(next)))
            {
                address = next;
            }
            else
            {
                throw new HttpRequestException("Graph SharePoint gave a next page outside the configured Graph address.");
            }
        }
    }

    /// <summary>The item of that name directly in the root folder, or null when there is none.</summary>
    public async Task<GraphDriveItem?> FindAsync(string name, CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        using var response = await http.GetAsync(SharePointNames.ItemAddress(driveId, Settings.RootFolder, name) + "?$select=id,name,webUrl,folder", cancellationToken);
        return response.StatusCode == HttpStatusCode.NotFound ? null : await SharePointHttp.ReadAsync<GraphDriveItem>(response, cancellationToken);
    }

    /// <summary>The item by its id, or null when SharePoint no longer has it.</summary>
    public async Task<GraphDriveItem?> GetAsync(string itemId, CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        using var response = await http.GetAsync($"drives/{Uri.EscapeDataString(driveId)}/items/{Uri.EscapeDataString(itemId)}?$select=id,name,webUrl,folder", cancellationToken);
        return response.StatusCode == HttpStatusCode.NotFound ? null : await SharePointHttp.ReadAsync<GraphDriveItem>(response, cancellationToken);
    }

    /// <summary>
    /// Creates the folder in the root folder. "fail" on a name that is taken: "replace" would empty a folder somebody made by hand, and
    /// "rename" would make a second one beside it. A taken name is a refusal (409) for the caller to handle.
    /// </summary>
    public async Task<GraphDriveItem> CreateFolderAsync(string name, CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        using var response = await http.PostAsJsonAsync(
            SharePointNames.ItemAddress(driveId, Settings.RootFolder, suffix: "/children"),
            new Dictionary<string, object?> { ["name"] = name, ["folder"] = new { }, ["@microsoft.graph.conflictBehavior"] = "fail" },
            cancellationToken);
        return await SharePointHttp.ReadAsync<GraphDriveItem>(response, cancellationToken);
    }

    /// <summary>Renames the item; SharePoint keeps its id, so the link survives.</summary>
    public async Task<GraphDriveItem> RenameAsync(string itemId, string name, CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"drives/{Uri.EscapeDataString(driveId)}/items/{Uri.EscapeDataString(itemId)}")
        {
            Content = JsonContent.Create(new { name }),
        };
        using var response = await http.SendAsync(request, cancellationToken);
        return await SharePointHttp.ReadAsync<GraphDriveItem>(response, cancellationToken);
    }

    /// <summary>The root folder itself: the connection test reads it.</summary>
    public async Task<GraphDriveItem> RootAsync(CancellationToken cancellationToken)
    {
        var driveId = await drive.IdAsync(http, cancellationToken);
        using var response = await http.GetAsync(SharePointNames.ItemAddress(driveId, Settings.RootFolder) + "?$select=id,name,webUrl,folder", cancellationToken);
        return await SharePointHttp.ReadAsync<GraphDriveItem>(response, cancellationToken);
    }
}

/// <summary>
/// The library's drive id: <c>SharePoint:DriveId</c> when it is set, else the library named <c>SharePoint:DriveName</c> on the site,
/// looked up once per process with whichever identity asks first (the application in crm-worker, the person in crm-web).
/// </summary>
public sealed class SharePointDrive(IOptions<GraphOptions> options)
{
    private string? _id;

    public async Task<string> IdAsync(HttpClient http, CancellationToken cancellationToken)
    {
        var settings = options.Value.SharePoint;
        if (!string.IsNullOrWhiteSpace(settings.DriveId))
        {
            return settings.DriveId;
        }

        if (Volatile.Read(ref _id) is { } known)
        {
            return known;
        }

        using var response = await http.GetAsync($"sites/{Uri.EscapeDataString(settings.SiteId ?? string.Empty)}/drives?$select=id,name", cancellationToken);
        var page = await SharePointHttp.ReadAsync<GraphDrivePage>(response, cancellationToken);
        var library = page.Value.FirstOrDefault(d => string.Equals(d.Name, settings.DriveName, StringComparison.OrdinalIgnoreCase))
                      ?? throw new HttpRequestException($"The SharePoint site has no library named {settings.DriveName}.", null, HttpStatusCode.NotFound);
        Volatile.Write(ref _id, library.Id);
        return library.Id;
    }
}

internal static class SharePointHttp
{
    /// <summary>The answer as <typeparamref name="T"/>; a failure carries the status only, never Graph's text about the item.</summary>
    public static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"Graph SharePoint answered {(int)response.StatusCode}.", null, response.StatusCode);
        }

        return await response.Content.ReadFromJsonAsync<T>(cancellationToken)
               ?? throw new HttpRequestException("Graph SharePoint returned an empty answer.");
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

internal sealed record GraphDriveItemPage(
    [property: JsonPropertyName("value")] IReadOnlyList<GraphDriveItem> Value,
    [property: JsonPropertyName("@odata.nextLink")] string? NextLink);

internal sealed record GraphDrive([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string? Name);

internal sealed record GraphDrivePage([property: JsonPropertyName("value")] IReadOnlyList<GraphDrive> Value);
