using System.Net;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// The customers' folders on the mapping screen (M47): the folders of the root folder are SharePoint's "customers", linked to
/// organizations like Atera's or CloudAlly's. A folder named "{name} ({org number})" links itself by the org number; the old folders
/// a person made carry no number and are only suggested by name, so a person decides. A folder never becomes a new organization.
/// </summary>
internal sealed class SharePointAdapter(IOptions<GraphOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => SharePointTypes.System;

    public bool IsEnabled => options.Value.SharePointEnabled;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } =
        [new(SharePointTypes.System, SharePointTypes.Folder, EntityTypes.Organization, Importable: false)];

    public string? CreateOrganizationOperation => null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == SharePointTypes.Folder
            ? new ExternalOrganizationData(SharePointNames.WithoutOrgNumber(record.DisplayName), record.OrgNumber, null, null, null, [], null, null, null)
            : null;

    public ExternalContactData? ToContactData(ExternalRecord record) => null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.SharePointEnabled || !options.Value.HasApplicationCredential)
        {
            return new ConnectionTestResult(false, "SharePoint or the application's Graph credentials are not configured on this instance.");
        }

        try
        {
            await services.GetRequiredService<SharePointClient>().RootAsync(cancellationToken);
            return new ConnectionTestResult(true, "Read the customers' root folder in SharePoint.");
        }
        catch (HttpRequestException exception)
        {
            return new ConnectionTestResult(false, exception.StatusCode is { } status
                ? $"SharePoint answered {(int)status} for the root folder."
                : "SharePoint could not be reached.");
        }
    }
}

/// <summary>SharePoint's write switches (M39.1), read again for every preview, request and attempt.</summary>
internal sealed class SharePointActionGate(IOptionsMonitor<GraphOptions> options) : IVendorActionGate
{
    public string System => SharePointTypes.System;

    public VendorActionSwitches Read()
    {
        var o = options.CurrentValue;
        var s = o.SharePoint;
        return new VendorActionSwitches(
            o.SharePointEnabled, o.SharePointEnabled && o.HasApplicationCredential, s.WriteEnabled, s.DryRun, [.. s.WriteAllowedCustomerIds], [.. s.EnabledActions]);
    }
}

internal static class SharePointMapping
{
    /// <summary>
    /// A folder as the mapping screen stores it: its name, its address in SharePoint and the org number its name carries. Only the
    /// folders of the root folder are stored, never what is in them (SEC-GDPR-06b).
    /// </summary>
    public static ExternalRecordInput ToRecord(GraphDriveItem folder) =>
        new(SharePointTypes.System, SharePointTypes.Folder, folder.Id, folder.Name ?? folder.Id,
            new { name = folder.Name, webUrl = folder.WebUrl }, folder.LastModifiedDateTime, OrgNumber: SharePointNames.OrgNumberOf(folder.Name));
}

/// <summary>
/// The folders of the root folder (<c>sharepoint-folders</c>, M47), stored for the mapping screen; a folder SharePoint no longer lists is
/// marked gone after a complete read. Runs in crm-worker on the application identity.
/// </summary>
public sealed class SharePointFolderSyncJob(
    SharePointClient client,
    ExternalRecordStore records,
    SyncRunner runner,
    TimeProvider time,
    IOptions<GraphOptions> options,
    ILogger<SharePointFolderSyncJob> logger)
{
    public const string JobId = "sharepoint-folders";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.SharePointEnabled || !options.Value.HasApplicationCredential)
        {
            logger.LogInformation("SharePoint folder sync skipped: SharePoint is not configured.");
            return;
        }

        await runner.RunAsync(SharePointTypes.System, JobId, async (progress, ct) =>
        {
            var scanStarted = time.GetUtcNow();
            await foreach (var folder in client.ListFoldersAsync(ct))
            {
                progress.Read++;
                if ((await records.UpsertAsync(SharePointMapping.ToRecord(folder), ct)).Changed)
                {
                    progress.Changed++;
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(SharePointTypes.System, SharePointTypes.Folder, scanStarted, ct);
            progress.Message = $"folders {progress.Read}, changed {progress.Changed}, no longer in SharePoint {gone}";
        }, cancellationToken);
    }
}

/// <summary>
/// Queues the rename of a customer's folder when the organization changed (FR-DOC-01). The handler only queues: the worker's outbound
/// processor calls SharePoint, with retries and the maintenance check (DEV-07, DEV-13).
/// </summary>
internal sealed class OrganizationFolderHandler(
    ExternalLinkService links,
    OutboundQueue queue,
    IOptions<GraphOptions> options) : IDomainEventHandler<OrganizationUpdated>
{
    public async Task HandleAsync(OrganizationUpdated domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.SharePointEnabled || !options.Value.SharePoint.WriteEnabled ||
            await links.FindByEntityAsync(EntityTypes.Organization, domainEvent.OrganizationId, SharePointTypes.System, SharePointTypes.Folder, cancellationToken)
                is null)
        {
            return;
        }

        await queue.EnqueueAsync(SharePointTypes.System, SharePointFolderRename.OperationName, EntityTypes.Organization, domainEvent.OrganizationId, null,
            cancellationToken);
    }
}

/// <summary>
/// Renames the customer's folder after the organization (FR-DOC-01), but only a folder that still carries the CRM's own name for it:
/// "{name} ({org number})". A folder a person named, or linked on the mapping screen, keeps its name, so links to its files from the old
/// wiki stay whole (M47).
/// </summary>
internal sealed class SharePointFolderRename(
    SharePointClient client,
    ICustomersApi customers,
    ExternalLinkService links,
    ExternalRecordStore records,
    IOptionsMonitor<GraphOptions> options) : IOutboundHandler
{
    public const string OperationName = "folder-rename";

    public string System => SharePointTypes.System;

    public string Operation => OperationName;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        var settings = options.CurrentValue;
        if (!settings.SharePointEnabled || !settings.HasApplicationCredential)
        {
            return new OutboundResult("SharePoint is not configured on this instance; nothing was renamed.");
        }

        if (await customers.GetOrganizationAsync(operation.EntityId, cancellationToken) is not { } organization ||
            await links.FindByEntityAsync(EntityTypes.Organization, organization.Id, System, SharePointTypes.Folder, cancellationToken) is not { } link)
        {
            return OutboundResult.NothingToDo;
        }

        if (await client.GetAsync(link.ExternalId, cancellationToken) is not { } folder)
        {
            return new OutboundResult("The linked folder is no longer in SharePoint; nothing was renamed.");
        }

        if (!SharePointNames.IsOwnName(folder.Name, organization.OrgNumber))
        {
            return new OutboundResult("The folder carries a name a person chose; it keeps it.", folder.Id);
        }

        var name = SharePointNames.FolderName(organization.Name, organization.OrgNumber);
        if (string.Equals(folder.Name, name, StringComparison.Ordinal))
        {
            return OutboundResult.NothingToDo;
        }

        if (!settings.SharePoint.WriteEnabled)
        {
            return new OutboundResult("Writing to SharePoint is switched off; the folder was not renamed.", folder.Id);
        }

        if (settings.SharePoint.DryRun)
        {
            return new OutboundResult("Test mode: SharePoint was read, the folder was not renamed.", folder.Id);
        }

        try
        {
            var renamed = await client.RenameAsync(folder.Id, name, cancellationToken);
            await records.UpsertAsync(SharePointMapping.ToRecord(renamed), cancellationToken);
            return new OutboundResult("Renamed after the organization.", renamed.Id);
        }
        catch (HttpRequestException refused) when (refused.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.Conflict)
        {
            // A name that is taken, or a right that is missing, does not go away on retry.
            throw new PermanentOutboundException($"SharePoint refused the new name ({(int)refused.StatusCode!.Value}).");
        }
    }
}
