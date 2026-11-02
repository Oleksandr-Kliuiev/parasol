using System.Net;
using Crm.Activities.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// What is in a customer's SharePoint folder, read with the signed-in person's own token (<c>Files.Read.All</c>, M47) so the card
/// shows what that person may open in SharePoint and nothing more (SEC-GDPR-06b). The CRM keeps the folder's id only: names and
/// files are read live and never stored. Every way the read can end is a state of its own, so the tab never shows "no folder"
/// for a folder it could not read.
/// </summary>
internal sealed class GraphDocumentLibrary(
    HttpClient http,
    ExternalLinkService links,
    ExternalRecordStore records,
    SharePointDrive drive,
    IOptions<GraphOptions> options,
    ILogger<GraphDocumentLibrary> logger) : IDocumentLibrary
{
    /// <summary>One page of the folder; the card says when there is more and leads to SharePoint for it (DEV-12: no silent cut).</summary>
    public const int PageSize = 200;

    private GraphSharePointOptions Settings => options.Value.SharePoint;

    public bool IsAvailable => options.Value.Enabled && Settings.Enabled && !string.IsNullOrWhiteSpace(Settings.SiteId);

    public async Task<DocumentListing> ReadAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (await links.FindByEntityAsync(EntityTypes.Organization, organizationId, SharePointTypes.System, SharePointTypes.Folder, cancellationToken)
            is not { } link)
        {
            return DocumentListing.Of(DocumentFolderState.NoFolder);
        }

        try
        {
            var driveId = await drive.IdAsync(http, cancellationToken);
            var address = $"drives/{Uri.EscapeDataString(driveId)}/items/{Uri.EscapeDataString(link.ExternalId)}";
            using var folderResponse = await http.GetAsync(address + "?$select=id,name,webUrl,folder", cancellationToken);
            if (folderResponse.StatusCode == HttpStatusCode.NotFound)
            {
                return DocumentListing.Of(await GoneOrHiddenAsync(link.ExternalId, cancellationToken), link.Id);
            }

            if (Refused(folderResponse.StatusCode) is { } refusedFolder)
            {
                return DocumentListing.Of(refusedFolder, link.Id);
            }

            var folder = await SharePointHttp.ReadAsync<GraphDriveItem>(folderResponse, cancellationToken);
            using var childrenResponse = await http.GetAsync(
                address + $"/children?$select=id,name,size,folder,webUrl,lastModifiedDateTime,lastModifiedBy&$top={PageSize}", cancellationToken);
            if (childrenResponse.StatusCode == HttpStatusCode.NotFound)
            {
                return DocumentListing.Of(await GoneOrHiddenAsync(link.ExternalId, cancellationToken), link.Id);
            }

            if (Refused(childrenResponse.StatusCode) is { } refusedChildren)
            {
                return DocumentListing.Of(refusedChildren, link.Id);
            }

            var page = await SharePointHttp.ReadAsync<GraphDriveItemPage>(childrenResponse, cancellationToken);
            var items = page.Value
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
            return new DocumentListing(
                DocumentFolderState.Ready, link.Id, new DocumentFolder(folder.Id, folder.Name ?? string.Empty, folder.WebUrl ?? string.Empty), items,
                More: page.NextLink is not null);
        }
        catch (UserNotConnectedException)
        {
            // No token for this person: the development sign-in, or consent for Files.Read.All not given yet (runbook 02 §4b.2).
            return DocumentListing.Of(DocumentFolderState.NotConnected, link.Id);
        }
        catch (Exception exception) when (exception is HttpRequestException || (exception is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            // SharePoint being slow or unreachable must not take the customer card with it (NFR-08); the tab offers to read again.
            logger.LogWarning("Reading the SharePoint folder of organization {Organization} failed ({ErrorType}, {Status}).",
                organizationId, exception.GetType().Name, (exception as HttpRequestException)?.StatusCode is { } status ? (int)status : null);
            return DocumentListing.Of(DocumentFolderState.Unavailable, link.Id);
        }
    }

    /// <summary>
    /// Graph answers 404 both for a folder that is gone and for one this person may not see. The CRM's own hourly listing of the root
    /// folder tells them apart: a folder it still lists is there, out of this person's reach; one it no longer lists (or never did) was
    /// deleted or moved out, and only then does the card offer to take the link off. Until the next listing a folder deleted just now
    /// reads as out of reach, which offers nothing that could not be undone.
    /// </summary>
    private async Task<DocumentFolderState> GoneOrHiddenAsync(string folderId, CancellationToken cancellationToken) =>
        await records.FindAsync(SharePointTypes.System, SharePointTypes.Folder, folderId, cancellationToken) is { IsGone: false }
            ? DocumentFolderState.NoAccess
            : DocumentFolderState.Gone;

    /// <summary>A refused read (the person may not open the folder) or a refused token (the sign-in has no access yet).</summary>
    private static DocumentFolderState? Refused(HttpStatusCode status) => status switch
    {
        HttpStatusCode.NotFound => DocumentFolderState.Gone,
        HttpStatusCode.Forbidden => DocumentFolderState.NoAccess,
        HttpStatusCode.Unauthorized => DocumentFolderState.NotConnected,
        _ => null,
    };
}
