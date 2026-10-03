using Crm.Customers.Contracts;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Logging;

namespace Crm.Customers.Features.Organizations;

/// <summary>What the Documents tab shows: the customer's SharePoint folder and what is in it (FR-DOC-01).</summary>
public sealed record OrganizationDocumentsDto(bool Available, DocumentFolder? Folder, IReadOnlyList<DocumentItem> Items);

/// <summary>
/// The customer's documents live in SharePoint, not in the CRM: the card shows the folder and links into it. When
/// SharePoint is not configured the tab says so instead of failing (FR-DOC-01).
/// </summary>
internal sealed class OrganizationDocumentsService(IEnumerable<IDocumentLibrary> libraries, ILogger<OrganizationDocumentsService> logger)
{
    private IDocumentLibrary? Library => libraries.FirstOrDefault(l => l.IsAvailable);

    public async Task<OrganizationDocumentsDto> ListAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (Library is not { } library)
        {
            return new OrganizationDocumentsDto(false, null, []);
        }

        try
        {
            var folder = await library.GetFolderAsync(organizationId, cancellationToken);
            var items = folder is null ? [] : await library.ListAsync(organizationId, cancellationToken);
            return new OrganizationDocumentsDto(true, folder, items);
        }
        catch (HttpRequestException exception)
        {
            // SharePoint being slow or unreachable must not take the customer card with it (NFR-08).
            logger.LogWarning(exception, "Reading the documents of organization {Organization} failed.", organizationId);
            return new OrganizationDocumentsDto(true, null, []);
        }
    }

    public async Task<Result<OrganizationDocumentsDto>> CreateFolderAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (Library is not { } library)
        {
            return Error.Conflict("CUS_SHAREPOINT_DISABLED", "SharePoint is not configured, so there is nowhere to create the folder.");
        }

        try
        {
            var folder = await library.EnsureFolderAsync(organizationId, cancellationToken);
            var items = await library.ListAsync(organizationId, cancellationToken);
            return new OrganizationDocumentsDto(true, folder, items);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning(exception, "Creating the SharePoint folder of organization {Organization} failed.", organizationId);
            return Error.Conflict("CUS_SHAREPOINT_FAILED", "SharePoint refused the request; try again or create the folder by hand.");
        }
    }
}
