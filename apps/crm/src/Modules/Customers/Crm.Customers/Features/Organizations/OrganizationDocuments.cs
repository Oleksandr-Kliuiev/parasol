using Crm.Customers.Contracts;

namespace Crm.Customers.Features.Organizations;

/// <summary>
/// What the Documents tab shows (FR-DOC-01, M47): whether SharePoint is set up, how reading the customer's folder ended, the link (so a
/// person may take a stale one off), the folder and its first page, and whether it holds more than that page.
/// </summary>
public sealed record OrganizationDocumentsDto(
    bool Available, DocumentFolderState State, Guid? LinkId, DocumentFolder? Folder, IReadOnlyList<DocumentItem> Items, bool More);

/// <summary>
/// The customer's documents live in SharePoint, not in the CRM: the card shows the folder and links into it. When SharePoint is not
/// configured the tab says so instead of failing; creating a folder is a vendor action of the integration (M47), not this module's.
/// </summary>
internal sealed class OrganizationDocumentsService(IEnumerable<IDocumentLibrary> libraries)
{
    public async Task<OrganizationDocumentsDto> ListAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (libraries.FirstOrDefault(l => l.IsAvailable) is not { } library)
        {
            return new OrganizationDocumentsDto(false, DocumentFolderState.NoFolder, null, null, [], false);
        }

        var listing = await library.ReadAsync(organizationId, cancellationToken);
        return new OrganizationDocumentsDto(true, listing.State, listing.LinkId, listing.Folder, listing.Items, listing.More);
    }
}
