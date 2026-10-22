using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Actions;
using Crm.Security.Contracts;
using Crm.Service.Contracts;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Closes an escalation with an answer (<c>escalation.resolve</c>, M41). Every escalation can be closed; an unwanted-access escalation
/// (a login from an unexpected country or VPN) also takes the answer whether the access was expected or not, for the identities it
/// names only. Without an answer Huntress treats such an escalation as dismissed until it happens again. The CRM never revokes or
/// disables an identity from here, and Huntress's API takes no text with a resolution: the person's note stays in the action log.
/// </summary>
internal sealed class HuntressEscalationResolveAction(
    ISecurityApi security, IServiceApi service, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack) : IVendorActionHandler
{
    /// <summary>The answers: a plain close, or for an unwanted-access escalation, expected or not.</summary>
    public static readonly string[] Answers = ["close", "expected", "unauthorized"];

    public string System => HuntressTypes.System;

    public string Kind => HuntressActionKinds.EscalationResolve;

    public string TargetType => VendorActionTargets.Alert;

    public VendorActionLevel Level => VendorActionLevel.Standard;

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    /// <summary>The attempt reads the escalation first and skips one already resolved.</summary>
    public bool IsRepeatable => true;

    /// <summary>An unwanted-access escalation, by Huntress's stable code: a login from an unexpected country or through a VPN.</summary>
    public static bool IsAccess(string? typeCode) =>
        typeCode is not null && (typeCode.Contains("country_access", StringComparison.Ordinal) || typeCode.Contains("vpn_access", StringComparison.Ordinal));

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (HuntressMapping.ReadAlertId(request.TargetId) is not ("escalation", var id) ||
            await security.GetNoticeAsync(HuntressTypes.System, NoticeKind.Escalation, id, cancellationToken) is not { } escalation)
        {
            return VendorActionPlan.NotFound;
        }

        var organization = escalation.OrganizationId is { } organizationId
            ? (await customers.GetOrganizationNamesAsync([organizationId], cancellationToken)).GetValueOrDefault(organizationId)
            : null;
        // The Huntress organization the alert stands under (the first linked one the escalation names) is the one the allow-list checks.
        var alert = await service.GetAlertAsync(HuntressTypes.System, request.TargetId, cancellationToken);
        var target = new VendorActionTarget(VendorActionTargets.Alert, request.TargetId, escalation.Subject, escalation.OrganizationId, organization,
            alert?.ExternalCustomerId ?? escalation.ExternalOrganizationId?.ToString(CultureInfo.InvariantCulture), escalation.Url);
        if (!escalation.IsOpen)
        {
            return VendorActionPlan.Blocked(target, "VND_ESCALATION_RESOLVED", "Huntress has resolved the escalation.");
        }

        var answer = Answer(request.Parameters);
        if (answer is null || (answer != "close" && !IsAccess(escalation.TypeCode)))
        {
            return VendorActionPlan.Blocked(target, "VND_ANSWER_INVALID", "Choose an answer this escalation takes.");
        }

        var effects = new List<VendorActionEffect>
        {
            answer switch
            {
                "expected" => new VendorActionEffect("VND_EFFECT_HUNTRESS_EXPECTED", new Dictionary<string, string?>()),
                "unauthorized" => new VendorActionEffect("VND_EFFECT_HUNTRESS_UNAUTHORIZED", new Dictionary<string, string?>()),
                _ => new VendorActionEffect("VND_EFFECT_HUNTRESS_ESCALATION_CLOSE", new Dictionary<string, string?>()),
            },
        };
        if (answer == "close" && IsAccess(escalation.TypeCode))
        {
            effects.Add(new VendorActionEffect("VND_EFFECT_HUNTRESS_DISMISSED", new Dictionary<string, string?>()));
        }

        return new VendorActionPlan(target, effects, null, VendorActionRules.Canonical(new Dictionary<string, object?> { ["answer"] = answer }));
    }

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        if (HuntressMapping.ReadAlertId(context.Action.TargetId) is not ("escalation", var id))
        {
            return VendorActionResult.Failed("VND_TARGET_GONE", "The action names no Huntress escalation; nothing was sent.");
        }

        HuntressNotice? live;
        try
        {
            live = await client.GetNoticeAsync(HuntressNoticeKind.Escalation, id, cancellationToken);
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Huntress could not be read before sending; nothing was sent.");
        }

        if (live is null)
        {
            await readBack.NoticeAsync(HuntressNoticeKind.Escalation, id, cancellationToken);
            return VendorActionResult.Failed("VND_TARGET_GONE", "Huntress no longer knows the escalation; nothing was sent.");
        }

        if (context.Action.ExternalCustomerId is { } customer &&
            !(long.TryParse(customer, NumberStyles.None, CultureInfo.InvariantCulture, out var organizationId) && live.OrganizationIds.Contains(organizationId)))
        {
            return VendorActionResult.Rejected("VND_ESCALATION_MOVED", "The escalation no longer names the customer's organization in Huntress; nothing was sent.");
        }

        if (!HuntressAlertSyncJob.OpenNoticeStatuses.Contains(live.Status))
        {
            await readBack.NoticeAsync(HuntressNoticeKind.Escalation, id, cancellationToken);
            return VendorActionResult.Skipped("VND_ALREADY_DONE", "Huntress has resolved the escalation already; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: Huntress was read, nothing was sent.");
        }

        var answer = Answer(context.Parameters) ?? "close";
        try
        {
            await client.ResolveEscalationAsync(id, answer == "close" ? HuntressEscalationAnswer.Close : new HuntressEscalationAnswer(answer), cancellationToken);
        }
        catch (HuntressApiException refused) when (HuntressFailures.IsRejection(refused.Status))
        {
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Huntress refused it ({(int)refused.Status}); nothing changed.");
        }

        await readBack.NoticeAsync(HuntressNoticeKind.Escalation, id, cancellationToken);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress resolved the escalation.");
    }

    private static string? Answer(JsonElement parameters) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("answer", out var value) && value.ValueKind == JsonValueKind.String &&
        Answers.Contains(value.GetString(), StringComparer.Ordinal)
            ? value.GetString()
            : null;
}

/// <summary>
/// What the agent actions share (M41): the target is a current Huntress device of the Service mirror (its machine name, its customer,
/// the Huntress organization it reports under, for the allow-list). The attempt reads the agent from Huntress first and refuses one
/// that moved to another organization; after sending, the agent is read again into the mirror.
/// </summary>
internal abstract class HuntressAgentAction(IServiceApi service, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : IVendorActionHandler
{
    public string System => HuntressTypes.System;

    public abstract string Kind { get; }

    public string TargetType => VendorActionTargets.Device;

    public abstract VendorActionLevel Level { get; }

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    /// <summary>The attempt reads the agent first: isolating an isolated host, or uninstalling a gone one, is skipped.</summary>
    public bool IsRepeatable => true;

    protected IHuntressActionClient Client => client;

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (!long.TryParse(request.TargetId, NumberStyles.None, CultureInfo.InvariantCulture, out _) ||
            await service.GetDeviceAsync(HuntressTypes.System, request.TargetId, cancellationToken) is not { } device)
        {
            return VendorActionPlan.NotFound;
        }

        var organization = (await customers.GetOrganizationNamesAsync([device.OrganizationId], cancellationToken)).GetValueOrDefault(device.OrganizationId);
        var target = new VendorActionTarget(VendorActionTargets.Device, request.TargetId, device.MachineName, device.OrganizationId, organization,
            device.AlternateId, null);
        return Plan(device, target);
    }

    protected abstract VendorActionPlan Plan(DeviceRef device, VendorActionTarget target);

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var id = long.Parse(context.Action.TargetId, NumberStyles.None, CultureInfo.InvariantCulture);
        HuntressAgent? live;
        try
        {
            live = await client.GetAgentAsync(id, cancellationToken);
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Huntress could not be read before sending; nothing was sent.");
        }

        if (live is not null && context.Action.ExternalCustomerId is { } customer && live.OrganizationId.ToString(CultureInfo.InvariantCulture) != customer)
        {
            return VendorActionResult.Rejected("VND_AGENT_MOVED", "The agent belongs to another organization in Huntress now; nothing was sent.");
        }

        if (Check(live) is { } outcome)
        {
            await ReadBackAsync(context, id, cancellationToken);
            return outcome;
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: Huntress was read, nothing was sent.");
        }

        VendorActionResult result;
        try
        {
            result = await SendAsync(context, id, cancellationToken);
        }
        catch (HuntressApiException refused) when (HuntressFailures.IsRejection(refused.Status))
        {
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Huntress refused it ({(int)refused.Status}); nothing changed.");
        }

        await ReadBackAsync(context, id, cancellationToken);
        return result;
    }

    private Task ReadBackAsync(VendorActionContext context, long id, CancellationToken ct) =>
        context.Action.OrganizationId is { } organizationId ? readBack.AgentAsync(id, organizationId, ct) : Task.CompletedTask;

    /// <summary>The outcome when the live agent makes the action pointless or impossible, else null.</summary>
    protected abstract VendorActionResult? Check(HuntressAgent? live);

    protected abstract Task<VendorActionResult> SendAsync(VendorActionContext context, long agentId, CancellationToken ct);

    protected static VendorActionEffect Effect(string code, string device) => new(code, new Dictionary<string, string?> { ["device"] = device });

    /// <summary>The isolation states Huntress reports for a host that is cut off from the network, or about to be.</summary>
    public static bool IsIsolated(string? firewallStatus) => firewallStatus is "Isolated" or "Pending Isolation";
}

/// <summary>
/// Isolates a host (<c>agent.isolate</c>) or releases it (<c>agent.release</c>): disruptive, as the customer notices it at once, so it
/// asks for a reason, which Huntress records with an isolation. Huntress confirms either at the host's next callback; until then the
/// device shows <c>Pending Isolation</c> or <c>Pending Release</c>.
/// </summary>
internal sealed class HuntressIsolationAction(
    bool isolate, IServiceApi service, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressAgentAction(service, customers, client, readBack)
{
    public override string Kind => isolate ? HuntressActionKinds.Isolate : HuntressActionKinds.Release;

    public override VendorActionLevel Level => VendorActionLevel.Disruptive;

    protected override VendorActionPlan Plan(DeviceRef device, VendorActionTarget target)
    {
        if (isolate && IsIsolated(device.Isolation))
        {
            return VendorActionPlan.Blocked(target, "VND_ALREADY_ISOLATED", "The machine is isolated, or about to be.");
        }

        if (!isolate && !IsIsolated(device.Isolation) && device.Isolation != "Pending Release")
        {
            return VendorActionPlan.Blocked(target, "VND_NOT_ISOLATED", "The machine is not isolated.");
        }

        return new VendorActionPlan(target,
            isolate
                ? [Effect("VND_EFFECT_HUNTRESS_ISOLATE", device.MachineName), Effect("VND_EFFECT_HUNTRESS_ISOLATE_CONFIRM", device.MachineName)]
                : [Effect("VND_EFFECT_HUNTRESS_RELEASE", device.MachineName), Effect("VND_EFFECT_HUNTRESS_RELEASE_CONFIRM", device.MachineName)],
            null, "{}");
    }

    protected override VendorActionResult? Check(HuntressAgent? live) =>
        live is null ? VendorActionResult.Failed("VND_TARGET_GONE", "Huntress no longer knows the agent; nothing was sent.")
        : isolate && IsIsolated(live.FirewallStatus) ? VendorActionResult.Skipped("VND_ALREADY_DONE", "Huntress has the host isolated already; nothing was sent.")
        : !isolate && !IsIsolated(live.FirewallStatus) ? VendorActionResult.Skipped("VND_ALREADY_DONE", "Huntress has the host released already; nothing was sent.")
        : null;

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long agentId, CancellationToken ct)
    {
        if (isolate)
        {
            await Client.IsolateAgentAsync(agentId, context.Action.Reason ?? string.Empty, ct);
            return VendorActionResult.Succeeded("VND_SENT", "Huntress scheduled the isolation; the host confirms it at its next callback.");
        }

        await Client.ReleaseAgentAsync(agentId, ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress scheduled the release; the host confirms it at its next callback.");
    }
}

/// <summary>
/// Uninstalls the Huntress agent of a host (<c>agent.uninstall</c>): destructive — the machine is no longer protected, and the agent
/// leaves the account at once — so it asks for a fresh sign-in, the machine's name typed, a reason and waits a minute before it is
/// sent. Huntress removes the agent at the host's next callback.
/// </summary>
internal sealed class HuntressUninstallAction(IServiceApi service, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressAgentAction(service, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Uninstall;

    public override VendorActionLevel Level => VendorActionLevel.Destructive;

    protected override VendorActionPlan Plan(DeviceRef device, VendorActionTarget target) => new(target,
        [Effect("VND_EFFECT_HUNTRESS_UNINSTALL", device.MachineName), Effect("VND_EFFECT_HUNTRESS_UNINSTALL_GAP", device.MachineName)], null, "{}");

    protected override VendorActionResult? Check(HuntressAgent? live) => live is null
        ? VendorActionResult.Skipped("VND_ALREADY_DONE", "Huntress no longer knows the agent; nothing was sent.")
        : null;

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long agentId, CancellationToken ct)
    {
        await Client.UninstallAgentAsync(agentId, ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress scheduled the uninstall; the agent left the account.");
    }
}
