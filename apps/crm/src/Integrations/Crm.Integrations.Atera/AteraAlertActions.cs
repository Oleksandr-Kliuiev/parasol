using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Actions;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Atera;

/// <summary>The alert actions (M40): what Atera's API v3 lets the CRM do with an alert. Snoozing is not among them.</summary>
public static class AteraAlertKinds
{
    public const string TargetType = VendorActionTargets.Alert;
    public const string Resolve = "alert.resolve";
    public const string Delete = "alert.delete";

    public static readonly string[] All = [Resolve, Delete];
}

/// <summary>
/// What both alert actions share: the target is the CRM's saved copy of the Atera alert (its title, its customer, the Atera customer
/// it was read under, for the allow-list); the attempt starts by reading the alert from Atera, refuses one that belongs to another
/// customer now, and skips one that is already as asked. The CRM never takes the action's word for the result: the alert is read
/// again from Atera, and only an alert Atera keeps archived (or no longer knows) is resolved in the mirror. Otherwise the next
/// scheduled read decides, as for any alert.
/// </summary>
internal abstract class AteraAlertAction(
    IServiceApi service, ICustomersApi customers, IAteraClient client, ILogger logger) : IVendorActionHandler
{
    public string System => AteraTypes.System;

    public abstract string Kind { get; }

    public string TargetType => AteraAlertKinds.TargetType;

    public abstract VendorActionLevel Level { get; }

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    /// <summary>Both are safe to repeat: the attempt reads the alert first, and an alert already so is skipped.</summary>
    public bool IsRepeatable => true;

    protected IAteraClient Client => client;

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (await service.GetAlertAsync(AteraTypes.System, request.TargetId, cancellationToken) is not { } alert)
        {
            return VendorActionPlan.NotFound;
        }

        var organization = (await customers.GetOrganizationNamesAsync([alert.OrganizationId], cancellationToken)).GetValueOrDefault(alert.OrganizationId);
        return Plan(alert, Target(alert, organization));
    }

    /// <summary>
    /// Many alerts planned in two reads (M45: a batch from the queue): the stored alerts, then their customers' names. An alert the CRM
    /// does not store is planned as not found, as one asked alone is.
    /// </summary>
    protected async Task<IReadOnlyDictionary<string, VendorActionPlan>> PlanManyAlertsAsync(IReadOnlyList<string> targetIds, CancellationToken ct)
    {
        var alerts = await service.GetAlertsAsync(AteraTypes.System, targetIds, ct);
        var names = alerts.Count == 0
            ? new Dictionary<Guid, string>()
            : await customers.GetOrganizationNamesAsync(alerts.Values.Select(a => a.OrganizationId).Distinct().ToList(), ct);
        return targetIds.Distinct(StringComparer.Ordinal).ToDictionary(id => id, id => alerts.TryGetValue(id, out var alert)
            ? Plan(alert, Target(alert, names.GetValueOrDefault(alert.OrganizationId)))
            : VendorActionPlan.NotFound, StringComparer.Ordinal);
    }

    /// <summary>The name a deletion asks to be typed is the alert's title, as the queue shows it.</summary>
    private static VendorActionTarget Target(AlertRef alert, string? organization) =>
        new(AteraAlertKinds.TargetType, alert.ExternalId, alert.Title, alert.OrganizationId, organization, alert.ExternalCustomerId, alert.Url);

    protected abstract VendorActionPlan Plan(AlertRef alert, VendorActionTarget target);

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var id = context.Action.TargetId;
        AteraAlert? live;
        try
        {
            live = await client.GetAlertAsync(id, cancellationToken);
        }
        catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Atera could not be read before sending; nothing was sent.");
        }

        if (live is not null && context.Action.ExternalCustomerId is { } customer &&
            live.CustomerId?.ToString(CultureInfo.InvariantCulture) != customer)
        {
            return VendorActionResult.Rejected("VND_ALERT_MOVED", "The alert belongs to another customer in Atera now; nothing was sent.");
        }

        if (AlreadyDone(live) is { } done)
        {
            await ConfirmAsync(id, live, cancellationToken);
            return done;
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: Atera was read, nothing was sent.");
        }

        try
        {
            await SendAsync(id, cancellationToken);
        }
        catch (AteraApiException refused) when (AteraCreateTicketHandler.IsRejection(refused.Status))
        {
            // Atera answered and refused: nothing changed. Timeouts, conflicts and 5xx prove nothing and stay with the runner.
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Atera refused it ({(int)refused.Status}); nothing changed.");
        }

        await ConfirmAsync(id, cancellationToken);
        return VendorActionResult.Succeeded("VND_SENT", Sent);
    }

    /// <summary>The outcome when Atera's alert is already as asked, else null.</summary>
    protected abstract VendorActionResult? AlreadyDone(AteraAlert? live);

    protected abstract Task SendAsync(string alertId, CancellationToken ct);

    protected abstract string Sent { get; }

    /// <summary>
    /// The read after the change confirms it: the alert is read from Atera now, and the mirror resolves it only when Atera keeps it
    /// archived or no longer knows it. A read that fails changes nothing; the next scheduled read of open alerts confirms it then.
    /// </summary>
    private async Task ConfirmAsync(string id, CancellationToken ct)
    {
        AteraAlert? live;
        try
        {
            live = await client.GetAlertAsync(id, ct);
        }
        catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, ct))
        {
            logger.LogWarning("Atera alert {AlertId} could not be read after the action ({ErrorType}); the scheduled read confirms it", id, ex.GetType().Name);
            return;
        }

        await ConfirmAsync(id, live, ct);
    }

    private async Task ConfirmAsync(string id, AteraAlert? live, CancellationToken ct)
    {
        if (live is null || live.Archived)
        {
            await service.ResolveAlertAsync(AteraTypes.System, id, ct);
        }
    }

    protected static VendorActionEffect Effect(string code, AlertRef alert) =>
        new(code, new Dictionary<string, string?> { ["title"] = alert.Title, ["device"] = string.IsNullOrWhiteSpace(alert.DeviceName) ? "—" : alert.DeviceName });
}

/// <summary>
/// Resolves an Atera alert (<c>PUT alerts/{id}</c>): it leaves Atera's open list; the CRM's next read resolves it here. It may be asked
/// for many alerts at once (M45: "Close in Atera" for a selection of the queue), one action per alert.
/// </summary>
internal sealed class AteraAlertResolveAction(IServiceApi service, ICustomersApi customers, IAteraClient client, ILogger<AteraAlertResolveAction> logger)
    : AteraAlertAction(service, customers, client, logger), IVendorActionBatchPlanner
{
    public Task<IReadOnlyDictionary<string, VendorActionPlan>> PlanManyAsync(VendorActionBatchRequest request, CancellationToken cancellationToken) =>
        PlanManyAlertsAsync(request.TargetIds, cancellationToken);

    public override string Kind => AteraAlertKinds.Resolve;

    public override VendorActionLevel Level => VendorActionLevel.Standard;

    protected override string Sent => "Atera resolved the alert.";

    protected override VendorActionPlan Plan(AlertRef alert, VendorActionTarget target) => alert.State == AlertState.Resolved
        ? VendorActionPlan.Blocked(target, "VND_ALERT_RESOLVED", "The alert is no longer open in Atera.")
        : new VendorActionPlan(target, [Effect("VND_EFFECT_ALERT_RESOLVE", alert), Effect("VND_EFFECT_ALERT_CONFIRM", alert)], null, "{}");

    protected override VendorActionResult? AlreadyDone(AteraAlert? live) => live is null || live.Archived
        ? VendorActionResult.Skipped("VND_ALREADY_DONE", "The alert is no longer open in Atera; nothing was sent.")
        : null;

    protected override Task SendAsync(string alertId, CancellationToken ct) => Client.ResolveAlertAsync(alertId, ct);
}

/// <summary>
/// Deletes an Atera alert (<c>DELETE alerts/{id}</c>), its history in Atera with it: destructive, so it asks for a fresh sign-in, the
/// typed title, a reason and waits a minute before it is sent.
/// </summary>
internal sealed class AteraAlertDeleteAction(IServiceApi service, ICustomersApi customers, IAteraClient client, ILogger<AteraAlertDeleteAction> logger)
    : AteraAlertAction(service, customers, client, logger)
{
    public override string Kind => AteraAlertKinds.Delete;

    public override VendorActionLevel Level => VendorActionLevel.Destructive;

    protected override string Sent => "Atera deleted the alert.";

    protected override VendorActionPlan Plan(AlertRef alert, VendorActionTarget target) =>
        new(target, [Effect("VND_EFFECT_ALERT_DELETE", alert), Effect("VND_EFFECT_ALERT_DELETE_HISTORY", alert)], null, "{}");

    protected override VendorActionResult? AlreadyDone(AteraAlert? live) => live is null
        ? VendorActionResult.Skipped("VND_ALREADY_DONE", "The alert is no longer in Atera; nothing was sent.")
        : null;

    protected override Task SendAsync(string alertId, CancellationToken ct) => Client.DeleteAlertAsync(alertId, ct);
}
