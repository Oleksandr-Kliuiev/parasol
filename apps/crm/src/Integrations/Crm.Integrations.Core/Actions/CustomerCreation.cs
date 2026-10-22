using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

/// <summary>A record the vendor has (or just made) for the customer: its id, its name there, and what the CRM stores of it.</summary>
public sealed record VendorCustomerRecord(string ExternalId, string Name, ExternalRecordInput Record);

/// <summary>What the kind's parameters come to: canonical, with the effects the preview shows, or the reason they do not do.</summary>
public sealed record CustomerCreationPlan(string CanonicalParameters, IReadOnlyList<VendorActionEffect> Effects, VendorActionBlock? Block = null);

/// <summary>How a failed request to the vendor ends: refused (nothing was made), busy (asked again later), or unknown (rethrown).</summary>
public enum VendorFailure
{
    Unknown,
    Refused,
    Busy,
}

/// <summary>
/// Creates the customer at a vendor from the CRM organization and links it at once (M43, the "Connect services" wizard): a customer in
/// Atera, an organization in Huntress, an account in CloudAlly. One rule for all three (DEV-19): the vendor is searched for our key
/// before anything is created, and again after an attempt that got no clear answer. A record with our key found after such an attempt
/// is the one that attempt made: it is adopted and linked. One found without such an attempt was made by someone else (in the
/// console, for another customer) and is never taken over silently: a person links it on the mapping screen. An earlier attempt whose
/// record cannot be found waits for a person instead of being sent again. The request is journaled under the organization, so a later
/// action for the same customer — or the mapping screen's export, for Atera — sees it.
/// </summary>
public abstract class CustomerCreationAction(
    ICustomersApi customers, IntegrationDbContext db, ExternalLinkService links, ExternalRecordStore records, IExternalEffectJournal journal)
    : IVendorActionHandler
{
    public abstract string System { get; }

    public abstract string Kind { get; }

    public string TargetType => VendorActionTargets.Organization;

    /// <summary>A new, empty record at the vendor: nothing the customer notices, so one button confirms it.</summary>
    public VendorActionLevel Level => VendorActionLevel.Standard;

    /// <summary>The action links the organization, as the mapping screen does.</summary>
    public string Permission => Permissions.IntegrationsManage;

    public string ReadPermission => Permissions.ServiceRead;

    /// <summary>Every attempt searches the vendor for our key first, so a repeat after no answer never creates a second record.</summary>
    public bool IsRepeatable => true;

    /// <summary>The vendor's name in the outcomes the CRM writes (English, for logs and the API).</summary>
    protected abstract string VendorName { get; }

    /// <summary>The external type the organization is linked with (the type the mapping screen shows for the vendor's customers).</summary>
    public abstract string ExternalType { get; }

    /// <summary>The vendor's console, for what its API cannot do (a configured address; none when it is not set).</summary>
    public virtual string? ConsoleUrl => null;

    /// <summary>The journal kind of the create request, written under the organization.</summary>
    protected abstract string EffectKind { get; }

    /// <summary>The parameters the wizard starts from for this organization (a Huntress key from the name, a CloudAlly data center).</summary>
    public virtual IReadOnlyDictionary<string, string?> Defaults(OrganizationSyncView organization) => new Dictionary<string, string?>();

    /// <summary>From saved data only: checks the parameters for this organization and says what will be created.</summary>
    protected abstract CustomerCreationPlan Prepare(OrganizationSyncView organization, JsonElement parameters);

    /// <summary>The saved records of the vendor that carry our key (from its last read), so the preview can say one exists already.</summary>
    protected abstract IQueryable<ExternalRecord> WithKey(IQueryable<ExternalRecord> saved, OrganizationSyncView organization, JsonElement parameters);

    /// <summary>The vendor's live records that carry our key; a read that fails throws.</summary>
    protected abstract Task<IReadOnlyList<VendorCustomerRecord>> FindAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct);

    /// <summary>Sends the create; the record the vendor answers with. A failure is classified by <see cref="Classify"/>.</summary>
    protected abstract Task<VendorCustomerRecord> CreateAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct);

    /// <summary>What a failed create means: the vendor refused it, was busy, or anything else (the outcome is unknown).</summary>
    protected abstract VendorFailure Classify(Exception exception, CancellationToken ct);

    /// <summary>Whether an exception of the search is a read that failed (and nothing was sent).</summary>
    protected abstract bool IsReadFailure(Exception exception, CancellationToken ct);

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(request.TargetId, out var id) ||
            await customers.GetOrganizationForSyncAsync(id, cancellationToken) is not { IsDeleted: false } organization)
        {
            return VendorActionPlan.NotFound;
        }

        // The vendor has no id for the customer yet: the allow-list may name the CRM organization instead (VendorActionRules.IsAllowed).
        var target = new VendorActionTarget(VendorActionTargets.Organization, id.ToString("D"), organization.Name, id, organization.Name, null, null);
        if (await links.FindByEntityAsync(EntityTypes.Organization, id, System, ExternalType, cancellationToken) is not null)
        {
            return VendorActionPlan.Blocked(target, "VND_ALREADY_CONNECTED", $"The customer is already linked to a record in {VendorName}.");
        }

        var plan = Prepare(organization, request.Parameters);
        if (plan.Block is { } invalid)
        {
            return VendorActionPlan.Blocked(target, invalid.Code, invalid.Message);
        }

        using var parameters = JsonDocument.Parse(plan.CanonicalParameters);
        var saved = WithKey(db.ExternalRecords.AsNoTracking().Where(r => r.System == System && r.ExternalType == ExternalType && !r.IsGone), organization,
                parameters.RootElement)
            .Where(r => !db.ExternalLinks.Any(l => l.System == r.System && l.ExternalType == r.ExternalType && l.ExternalId == r.ExternalId));
        if (await saved.OrderBy(r => r.DisplayName).Select(r => r.DisplayName).FirstOrDefaultAsync(cancellationToken) is { } existing)
        {
            return new VendorActionPlan(target, [], new VendorActionBlock("VND_EXISTS_AT_VENDOR",
                $"{VendorName} already has a record with this key ({existing}); link it on the mapping screen if it is this customer."), plan.CanonicalParameters);
        }

        return new VendorActionPlan(target, plan.Effects, null, plan.CanonicalParameters);
    }

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(context.Action.TargetId, out var id) ||
            await customers.GetOrganizationForSyncAsync(id, cancellationToken) is not { IsDeleted: false } organization)
        {
            return VendorActionResult.Rejected("VND_TARGET_GONE", "The organization no longer exists in the CRM; nothing was sent.");
        }

        if (await links.FindByEntityAsync(EntityTypes.Organization, id, System, ExternalType, cancellationToken) is { } link)
        {
            return VendorActionResult.Skipped("VND_ALREADY_CONNECTED", $"The customer was already linked to {VendorName} record {link.ExternalId}; nothing was sent.");
        }

        // The parameters were checked by the preview and the command; a stored action whose parameters no longer do sends nothing.
        if (Prepare(organization, context.Parameters).Block is { } invalid)
        {
            return VendorActionResult.Rejected(invalid.Code, invalid.Message + " Nothing was sent.");
        }

        var earlier = (await journal.ForEntityAsync(EntityTypes.Organization, id, cancellationToken))
            .Where(e => e.System == System && e.Kind == EffectKind).ToList();
        var mayExist = ExternalEffects.MayExist(earlier);
        IReadOnlyList<VendorCustomerRecord> found;
        try
        {
            found = await FindAsync(organization, context.Parameters, cancellationToken);
        }
        catch (Exception ex) when (IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", $"{VendorName} could not be searched before creating; nothing was sent.");
        }

        if (found.Count > 0)
        {
            return await SettleFoundAsync(context, organization, found, mayExist, ExternalEffects.LatestReference(earlier), cancellationToken);
        }

        if (mayExist)
        {
            return VendorActionResult.Uncertain("VND_CREATE_NOT_FOUND",
                $"An earlier attempt got no answer and {VendorName} shows no record with our key; check there before asking again.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", $"Test mode: {VendorName} was searched, nothing was created.");
        }

        var effect = await journal.BeginAsync(new ExternalEffect(System, EffectKind, EntityTypes.Organization, id, context.Action.OutboundOperationId), cancellationToken);
        VendorCustomerRecord created;
        try
        {
            created = await CreateAsync(organization, context.Parameters, cancellationToken);
        }
        catch (Exception ex) when (Classify(ex, cancellationToken) is not VendorFailure.Unknown)
        {
            // The vendor answered and made nothing: the attempt is closed, so the next one may create.
            await journal.CompleteAsync(effect, EffectPhase.Failed, null, cancellationToken);
            return Classify(ex, cancellationToken) == VendorFailure.Busy
                ? VendorActionResult.Later("VND_VENDOR_BUSY", $"{VendorName}'s request limit was reached; nothing was created.")
                : VendorActionResult.Failed("VND_VENDOR_REFUSED", $"{VendorName} refused to create it; nothing was created.");
        }

        // The vendor's id is on record before the local writes, so an attempt after a failed link adopts it instead of creating again.
        await journal.CompleteAsync(effect, EffectPhase.Sent, created.ExternalId, cancellationToken);
        return await AdoptAsync(context, organization, created, "VND_CREATED", $"Created in {VendorName} and linked", cancellationToken);
    }

    /// <summary>
    /// A record with our key exists. After an attempt of ours that may have made it, it is that record: the one the journal named when the
    /// vendor answered with an id, else the only one. Otherwise it is someone else's, and nothing is taken over.
    /// </summary>
    private async Task<VendorActionResult> SettleFoundAsync(
        VendorActionContext context, OrganizationSyncView organization, IReadOnlyList<VendorCustomerRecord> found, bool mayExist, string? reported,
        CancellationToken ct)
    {
        var ours = !mayExist ? null
            : reported is not null ? found.SingleOrDefault(r => string.Equals(r.ExternalId, reported, StringComparison.Ordinal))
            : found.Count == 1 ? found[0]
            : null;
        if (ours is null)
        {
            return found.Count > 1
                ? VendorActionResult.Rejected("VND_AMBIGUOUS_AT_VENDOR", $"{VendorName} has {found.Count} records with our key; link the right one on the mapping screen. Nothing was sent.")
                : VendorActionResult.Rejected("VND_EXISTS_AT_VENDOR",
                    $"{VendorName} already has a record with our key ({found[0].ExternalId}); link it on the mapping screen if it is this customer. Nothing was sent.");
        }

        return await AdoptAsync(context, organization, ours, "VND_CREATED_EARLIER", $"An earlier attempt had created it in {VendorName}; linked", ct);
    }

    /// <summary>Stores the vendor's record for the mapping screen and links it to the organization.</summary>
    private async Task<VendorActionResult> AdoptAsync(
        VendorActionContext context, OrganizationSyncView organization, VendorCustomerRecord record, string code, string what, CancellationToken ct)
    {
        if (await links.FindByExternalAsync(System, ExternalType, record.ExternalId, ct) is { } other && other.EntityId != organization.Id)
        {
            return VendorActionResult.Rejected("VND_LINKED_ELSEWHERE",
                $"{VendorName} record {record.ExternalId} is linked to another customer in the CRM; nothing was changed.");
        }

        await records.UpsertAsync(record.Record, ct);
        var linked = await links.LinkAsync(EntityTypes.Organization, organization.Id, System, ExternalType, record.ExternalId, LinkMethod.Exported,
            context.Action.RequestedBy, ct);
        return linked.IsSuccess
            ? VendorActionResult.Succeeded(code, $"{what} ({record.ExternalId}).", record.ExternalId)
            : VendorActionResult.Succeeded("VND_CREATED_NOT_LINKED",
                $"{VendorName} has the record ({record.ExternalId}), but it could not be linked: {linked.Error!.Message} Link it on the mapping screen.",
                record.ExternalId);
    }

    /// <summary>A configured console address as a link: absolute https only, else none.</summary>
    protected static string? Link(string? url) =>
        Uri.TryCreate(url?.Trim(), UriKind.Absolute, out var address) && address.Scheme == Uri.UriSchemeHttps ? address.ToString() : null;

    /// <summary>A text parameter, trimmed; null when it is missing, empty or not text.</summary>
    protected static string? Text(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String &&
        value.GetString()?.Trim() is { Length: > 0 } text
            ? text
            : null;

    protected static VendorActionEffect Effect(string code, params (string Key, string? Value)[] values) =>
        new(code, values.ToDictionary(v => v.Key, v => v.Value));
}
