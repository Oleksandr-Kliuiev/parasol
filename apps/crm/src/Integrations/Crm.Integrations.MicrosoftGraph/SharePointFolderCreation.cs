using System.Net;
using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// The customer's folder in SharePoint, created when a person asks for it (M47: the documents tab and the "Connect services" wizard) on
/// the M43 path every vendor's customer takes. Our key is the CRM's folder name, "{name} ({org number})", in the root folder. A folder a
/// person made for the customer — under the customer's name with or without its company form — is not made a second time: the preview
/// and the attempt both stop and send the person to the mapping screen to link it. The folder links to the organization at once.
/// </summary>
internal sealed class SharePointFolderCreation(
    SharePointClient client,
    IOptionsMonitor<GraphOptions> options,
    ICustomersApi customers,
    IntegrationDbContext db,
    ExternalLinkService links,
    ExternalRecordStore records,
    IExternalEffectJournal journal)
    : CustomerCreationAction(customers, db, links, records, journal)
{
    /// <summary>The journal kind of the folder POST, written under the CRM organization. The reference is the folder's item id.</summary>
    public const string FolderEffect = "folder-post";

    public override string System => SharePointTypes.System;

    public override string Kind => SharePointActionKinds.FolderCreate;

    protected override string VendorName => "SharePoint";

    public override string ExternalType => SharePointTypes.Folder;

    protected override string EffectKind => FolderEffect;

    private string Root => SharePointNames.RootPath(options.CurrentValue.SharePoint.RootFolder);

    /// <summary>What the wizard shows before anything is asked: the folder's name and where it goes. Nothing there is for a person to choose.</summary>
    public override IReadOnlyDictionary<string, string?> Defaults(OrganizationSyncView organization) =>
        new Dictionary<string, string?> { ["name"] = Name(organization), ["root"] = Root };

    protected override CustomerCreationPlan Prepare(OrganizationSyncView organization, JsonElement parameters) =>
        new("{}",
        [
            Effect("VND_EFFECT_SHAREPOINT_FOLDER_CREATE", ("name", Name(organization)), ("root", Root)),
            Effect("VND_EFFECT_CUSTOMER_LINKED", ("vendor", VendorName)),
        ]);

    /// <summary>
    /// The saved folders that are the customer's already: the CRM's name for it, its org number in a name, or the names a person would have
    /// given it (SQL Server compares without case).
    /// </summary>
    protected override IQueryable<ExternalRecord> WithKey(IQueryable<ExternalRecord> saved, OrganizationSyncView organization, JsonElement parameters)
    {
        var names = SharePointNames.PlainNames(organization.Name).Append(Name(organization)).ToList();
        var orgNumber = string.IsNullOrWhiteSpace(organization.OrgNumber) ? null : organization.OrgNumber.Trim();
        return saved.Where(r => names.Contains(r.DisplayName) || (orgNumber != null && r.OrgNumber == orgNumber));
    }

    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct) =>
        await client.FindAsync(Name(organization), ct) is { Folder: not null } folder ? [Record(folder)] : [];

    /// <summary>A folder a person made for the customer before the CRM did, under its plain name: never made a second time.</summary>
    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindByNameAsync(OrganizationSyncView organization, CancellationToken ct)
    {
        var found = new List<VendorCustomerRecord>();
        foreach (var name in SharePointNames.PlainNames(organization.Name))
        {
            if (await client.FindAsync(name, ct) is { Folder: not null } folder)
            {
                found.Add(Record(folder));
            }
        }

        return found;
    }

    protected override async Task<VendorCustomerRecord> CreateAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct) =>
        Record(await client.CreateFolderAsync(Name(organization), ct));

    /// <summary>
    /// SharePoint answered and made nothing: a name taken meanwhile (409), a request it would not take, or a right missing on the site
    /// (<c>Sites.Selected</c> without write) — refused; its request limit — busy. Anything else (a timeout) leaves the outcome unknown.
    /// </summary>
    protected override VendorFailure Classify(Exception exception, CancellationToken ct) => exception switch
    {
        HttpRequestException { StatusCode: HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable } => VendorFailure.Busy,
        HttpRequestException { StatusCode: HttpStatusCode.BadRequest or HttpStatusCode.Forbidden or HttpStatusCode.NotFound or HttpStatusCode.Conflict } =>
            VendorFailure.Refused,
        _ => VendorFailure.Unknown,
    };

    protected override bool IsReadFailure(Exception exception, CancellationToken ct) =>
        exception is HttpRequestException || (exception is TaskCanceledException && !ct.IsCancellationRequested);

    private static string Name(OrganizationSyncView organization) => SharePointNames.FolderName(organization.Name, organization.OrgNumber);

    private static VendorCustomerRecord Record(GraphDriveItem folder) => new(folder.Id, folder.Name ?? folder.Id, SharePointMapping.ToRecord(folder));
}
