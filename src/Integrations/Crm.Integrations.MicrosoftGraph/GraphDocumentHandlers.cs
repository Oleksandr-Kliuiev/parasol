using Crm.Customers.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Keeps the SharePoint folder in step with the organization (FR-DOC-01): it appears when the organization becomes a
/// customer and follows a rename. A failure only writes a warning — a missing folder must never block saving a customer.
/// </summary>
internal sealed class OrganizationFolderHandler(
    GraphDocuments documents,
    ICustomersApi customers,
    IOptions<GraphOptions> options,
    ILogger<OrganizationFolderHandler> logger) : IDomainEventHandler<OrganizationCreated>, IDomainEventHandler<OrganizationUpdated>
{
    public Task HandleAsync(OrganizationCreated domainEvent, CancellationToken cancellationToken) =>
        ApplyAsync(domainEvent.OrganizationId, cancellationToken);

    public Task HandleAsync(OrganizationUpdated domainEvent, CancellationToken cancellationToken) =>
        ApplyAsync(domainEvent.OrganizationId, cancellationToken);

    private async Task ApplyAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (!options.Value.SharePoint.Enabled || !documents.IsAvailable)
        {
            return;
        }

        if (await customers.GetOrganizationAsync(organizationId, cancellationToken) is not { } organization)
        {
            return;
        }

        try
        {
            // Leads and prospects get no folder; it is created the moment they become a customer or a partner.
            if (organization.Status is not (OrganizationStatus.Customer or OrganizationStatus.Partner))
            {
                return;
            }

            if (await documents.GetFolderAsync(organizationId, cancellationToken) is null)
            {
                await documents.EnsureFolderAsync(organizationId, cancellationToken);
                return;
            }

            await documents.RenameFolderAsync(organizationId, organization.Name, organization.OrgNumber, cancellationToken);
        }
        catch (HttpRequestException exception)
        {
            logger.LogWarning("The SharePoint folder of organization {Organization} could not be kept in step ({ErrorType}).", organizationId, exception.GetType().Name);
        }
        catch (InvalidOperationException exception)
        {
            logger.LogWarning("SharePoint is configured but not usable for organization {Organization} ({ErrorType}).", organizationId, exception.GetType().Name);
        }
    }
}
