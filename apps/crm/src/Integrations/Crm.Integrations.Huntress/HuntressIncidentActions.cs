using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Actions;
using Crm.Security.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>The kinds of action people may ask of Huntress (M41), each off until <c>EnabledActions</c> lists it.</summary>
public static class HuntressActionKinds
{
    public const string Approve = "incident.approve";
    public const string Reject = "incident.reject";
    public const string Step = "incident.step";
    public const string Resolve = "incident.resolve";
    public const string Comment = "incident.comment";
    public const string EscalationResolve = "escalation.resolve";
    public const string Isolate = "agent.isolate";
    public const string Release = "agent.release";
    public const string Uninstall = "agent.uninstall";

    /// <summary>M43: the customer's organization created from the "Connect services" wizard.</summary>
    public const string OrganizationCreate = "organization.create";

    public static readonly string[] All = [Approve, Reject, Step, Resolve, Comment, EscalationResolve, Isolate, Release, Uninstall, OrganizationCreate];

    /// <summary>Huntress caps a comment, and a rejection's explanation, at 2048 characters.</summary>
    public const int MaxTextLength = 2048;

    /// <summary>The reasons Huntress takes for sending a plan back (<c>bulk_rejection</c>), for endpoints and for Microsoft 365.</summary>
    public static readonly string[] RejectionReasons =
    [
        "approved_application", "manually_remediated", "host_reimaged", "testing_security_controls", "other",
        "approved_user_login_location_m365", "approved_user_email_forwarding_rule_m365", "approved_application_m365", "manually_remediated_m365",
        "testing_security_controls_m365", "approved_vpn_or_proxy_usage_m365", "other_m365",
    ];
}

/// <summary>Huntress's write switches (M41), read again for every preview, request and attempt.</summary>
internal sealed class HuntressActionGate(IOptionsMonitor<HuntressOptions> options) : IVendorActionGate
{
    public string System => HuntressTypes.System;

    public VendorActionSwitches Read()
    {
        var o = options.CurrentValue;
        return new VendorActionSwitches(o.Enabled, o.IsConfigured, o.WriteEnabled, o.DryRun, o.WriteAllowedCustomerIds, o.EnabledActions);
    }
}

/// <summary>
/// What every incident action shares (M41): the target is the incident's alert (<c>incident:{id}</c>), planned from the security
/// mirror's copy (its subject, plan, customer and the Huntress organization it was read under, for the allow-list). The attempt reads
/// the report from Huntress first, refuses one that moved to another organization and skips one already as asked; after sending, the
/// report is read again into the mirror, and its alert is resolved only when Huntress shows it closed.
/// </summary>
internal abstract class HuntressIncidentAction(
    ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack) : IVendorActionHandler
{
    public string System => HuntressTypes.System;

    public abstract string Kind { get; }

    public string TargetType => VendorActionTargets.Alert;

    public VendorActionLevel Level => VendorActionLevel.Standard;

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    /// <summary>Repeatable unless a kind says otherwise: the attempt reads the report first and skips what is already so.</summary>
    public virtual bool IsRepeatable => true;

    /// <summary>
    /// What the action says about the incident's closing for the read after it: most actions close nothing, so an urgent incident
    /// Huntress closes meanwhile still waits for a person (<paramref name="sent"/>: Huntress accepted the request).
    /// </summary>
    protected virtual IncidentClosing Closing(bool sent) => IncidentClosing.NotAsked;

    /// <summary>Whether the read after the action reads the comments too: only an action that writes one changes them.</summary>
    protected virtual bool ChangesComments => false;

    protected IHuntressActionClient Client => client;

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (HuntressMapping.ReadAlertId(request.TargetId) is not ("incident", var id) ||
            await security.GetIncidentAsync(HuntressTypes.System, id, cancellationToken) is not { } incident)
        {
            return VendorActionPlan.NotFound;
        }

        var organization = (await customers.GetOrganizationNamesAsync([incident.OrganizationId], cancellationToken)).GetValueOrDefault(incident.OrganizationId);
        var target = new VendorActionTarget(VendorActionTargets.Alert, request.TargetId, incident.Subject, incident.OrganizationId, organization,
            incident.ExternalOrganizationId.ToString(CultureInfo.InvariantCulture), incident.Url);
        return Plan(incident, target, request.Parameters);
    }

    protected abstract VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters);

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        if (HuntressMapping.ReadAlertId(context.Action.TargetId) is not ("incident", var id))
        {
            return VendorActionResult.Failed("VND_TARGET_GONE", "The action names no Huntress incident; nothing was sent.");
        }

        HuntressIncident? live;
        IReadOnlyList<HuntressRemediation> plan;
        try
        {
            live = await client.GetIncidentAsync(id, cancellationToken);
            plan = live is null ? [] : live.AllRemediations ? live.Remediations : await client.GetRemediationsAsync(id, cancellationToken);
        }
        catch (Exception ex) when (HuntressFailures.IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Huntress could not be read before sending; nothing was sent.");
        }

        if (live is null)
        {
            await readBack.IncidentAsync(id, Closing(sent: false), cancellationToken);
            return VendorActionResult.Failed("VND_TARGET_GONE", "Huntress no longer knows the incident; nothing was sent.");
        }

        if (context.Action.ExternalCustomerId is { } customer && live.OrganizationId.ToString(CultureInfo.InvariantCulture) != customer)
        {
            return VendorActionResult.Rejected("VND_INCIDENT_MOVED", "The incident belongs to another organization in Huntress now; nothing was sent.");
        }

        if (Check(live, plan, context.Parameters) is { } outcome)
        {
            await readBack.IncidentAsync(id, Closing(sent: false), cancellationToken);
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
            // Huntress answered and refused: nothing changed. Timeouts and 5xx prove nothing and stay with the runner.
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Huntress refused it ({(int)refused.Status}); nothing changed.");
        }
        catch (HuntressApiException busy) when (HuntressFailures.IsBusy(busy.Status))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Huntress's request limit was reached; nothing was sent.");
        }

        await readBack.IncidentAsync(id, Closing(sent: true), cancellationToken, ChangesComments);
        return result;
    }

    /// <summary>The outcome when the live report makes the action pointless or impossible (already so, no longer waiting), else null.</summary>
    protected abstract VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters);

    protected abstract Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct);

    protected static VendorActionEffect Effect(string code, params (string Name, string? Value)[] values) =>
        new(code, values.ToDictionary(v => v.Name, v => (string?)(string.IsNullOrWhiteSpace(v.Value) ? "—" : v.Value)));

    protected static string? Text(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    protected static bool? Flag(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean()
            : null;

    protected static long? Number(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt64(out var number) && number > 0
            ? number
            : null;

    /// <summary>A report waits for the partner's answer to its plan only while Huntress has it <c>sent</c>.</summary>
    protected static VendorActionPlan? NotWaiting(IncidentView incident, VendorActionTarget target) =>
        !incident.IsOpen ? VendorActionPlan.Blocked(target, "VND_INCIDENT_CLOSED", "Huntress has closed the incident.")
        : incident.Status != "sent" ? VendorActionPlan.Blocked(target, "VND_INCIDENT_NOT_SENT", "The incident is with Huntress's SOC or its automation now, not waiting for you.")
        : null;

    protected static VendorActionResult? NotWaiting(HuntressIncident live) =>
        !HuntressMapping.IsOpen(live.Status) ? VendorActionResult.Skipped("VND_ALREADY_DONE", "Huntress has closed the incident; nothing was sent.")
        : live.Status != "sent" ? VendorActionResult.Rejected("VND_INCIDENT_NOT_SENT", "The incident is no longer waiting for you in Huntress; nothing was sent.")
        : null;
}

/// <summary>Approves every unapproved remediation (<c>bulk_approval</c>): Huntress then carries out the assisted ones.</summary>
internal sealed class HuntressApproveAction(ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressIncidentAction(security, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Approve;

    protected override VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters)
    {
        if (NotWaiting(incident, target) is { } blocked)
        {
            return blocked;
        }

        var waiting = incident.Remediations.Where(r => r.Status == "unapproved").ToList();
        if (waiting.Count == 0)
        {
            return VendorActionPlan.Blocked(target, "VND_NOTHING_TO_APPROVE", "No remediation waits for approval.");
        }

        var effects = new List<VendorActionEffect>
        {
            Effect("VND_EFFECT_HUNTRESS_APPROVE", ("count", waiting.Count.ToString(CultureInfo.InvariantCulture))),
        };
        if (waiting.Count(r => r.Type != "manual") is > 0 and var automated)
        {
            effects.Add(Effect("VND_EFFECT_HUNTRESS_APPROVE_ASSISTED", ("count", automated.ToString(CultureInfo.InvariantCulture))));
        }

        if (waiting.Count(r => r.Type == "manual") is > 0 and var manual)
        {
            effects.Add(Effect("VND_EFFECT_HUNTRESS_APPROVE_MANUAL", ("count", manual.ToString(CultureInfo.InvariantCulture))));
        }

        return new VendorActionPlan(target, effects, null, "{}");
    }

    protected override VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters) =>
        NotWaiting(live) ?? (plan.Any(r => r.Status == "unapproved")
            ? null
            : VendorActionResult.Skipped("VND_ALREADY_DONE", "No remediation waits for approval in Huntress; nothing was sent."));

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct)
    {
        await Client.ApproveRemediationsAsync(incidentId, ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress approved the remediations.");
    }
}

/// <summary>
/// Rejects every unapproved remediation (<c>bulk_rejection</c>) with a reason and an explanation: the report goes back to the SOC, which
/// fixes the plan and sends it again. The person's name and address are left to the user the key belongs to.
/// </summary>
internal sealed class HuntressRejectAction(ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressIncidentAction(security, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Reject;

    protected override VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters)
    {
        if (NotWaiting(incident, target) is { } blocked)
        {
            return blocked;
        }

        var waiting = incident.Remediations.Count(r => r.Status == "unapproved");
        if (waiting == 0)
        {
            return VendorActionPlan.Blocked(target, "VND_NOTHING_TO_APPROVE", "No remediation waits for approval.");
        }

        var reason = Text(parameters, "reason");
        if (reason is null || !HuntressActionKinds.RejectionReasons.Contains(reason, StringComparer.Ordinal))
        {
            return VendorActionPlan.Blocked(target, "VND_REASON_INVALID", "Choose why the plan is sent back.");
        }

        var comment = Text(parameters, "comment")?.Trim();
        if (string.IsNullOrEmpty(comment))
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_REQUIRED", "Write what Huntress's SOC should know.");
        }

        if (comment.Length > HuntressActionKinds.MaxTextLength)
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_TOO_LONG", $"The text is longer than {HuntressActionKinds.MaxTextLength} characters.");
        }

        var useful = Flag(parameters, "useful") ?? false;
        return new VendorActionPlan(target,
            [
                Effect("VND_EFFECT_HUNTRESS_REJECT", ("count", waiting.ToString(CultureInfo.InvariantCulture))),
                Effect("VND_EFFECT_HUNTRESS_BACK_TO_SOC"),
            ],
            null,
            VendorActionRules.Canonical(new Dictionary<string, object?> { ["reason"] = reason, ["comment"] = comment, ["useful"] = useful }));
    }

    protected override VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters) =>
        live.Status == "draft"
            ? VendorActionResult.Skipped("VND_ALREADY_DONE", "The incident is back with Huntress's SOC already; nothing was sent.")
            : NotWaiting(live) ?? (plan.Any(r => r.Status == "unapproved")
                ? null
                : VendorActionResult.Skipped("VND_ALREADY_DONE", "No remediation waits for approval in Huntress; nothing was sent."));

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct)
    {
        await Client.RejectRemediationsAsync(incidentId, new HuntressRejection(
            Text(context.Parameters, "comment")!, Flag(context.Parameters, "useful") ?? false, Text(context.Parameters, "reason")!), ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress sent the incident back to its SOC.");
    }
}

/// <summary>
/// Marks a manual remediation done, or not done again (<c>completion</c>). Only a step a person carries out can be marked; marking it
/// does not approve it, and the last open step may close the report in Huntress.
/// </summary>
internal sealed class HuntressStepAction(ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressIncidentAction(security, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Step;

    /// <summary>The last manual step marked done may close the incident in Huntress: then a person closed it, and nothing waits.</summary>
    protected override IncidentClosing Closing(bool sent) => sent ? IncidentClosing.MayClose : IncidentClosing.NotAsked;

    protected override VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters)
    {
        if (!incident.IsOpen)
        {
            return VendorActionPlan.Blocked(target, "VND_INCIDENT_CLOSED", "Huntress has closed the incident.");
        }

        if (Number(parameters, "remediation") is not { } id || incident.Remediations.FirstOrDefault(r => r.ExternalId == id) is not { } step)
        {
            return VendorActionPlan.Blocked(target, "VND_STEP_UNKNOWN", "The incident has no such remediation step.");
        }

        if (step.Type != "manual")
        {
            return VendorActionPlan.Blocked(target, "VND_STEP_NOT_MANUAL", "Huntress carries out this step itself; only a manual step is marked.");
        }

        var completed = Flag(parameters, "completed") ?? true;
        if ((step.Status == "completed") == completed)
        {
            return VendorActionPlan.Blocked(target, "VND_STEP_ALREADY", completed ? "The step is marked done already." : "The step is not marked done.");
        }

        var effects = new List<VendorActionEffect>
        {
            Effect(completed ? "VND_EFFECT_HUNTRESS_STEP_DONE" : "VND_EFFECT_HUNTRESS_STEP_UNDONE", ("step", step.Action ?? $"#{id}")),
        };
        if (completed)
        {
            effects.Add(Effect("VND_EFFECT_HUNTRESS_STEP_LAST"));
        }

        return new VendorActionPlan(target, effects, null,
            VendorActionRules.Canonical(new Dictionary<string, object?> { ["remediation"] = id, ["completed"] = completed }));
    }

    protected override VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters)
    {
        var id = Number(parameters, "remediation");
        if (plan.FirstOrDefault(r => r.Id == id) is not { } step)
        {
            return VendorActionResult.Failed("VND_TARGET_GONE", "Huntress no longer has the step; nothing was sent.");
        }

        var completed = Flag(parameters, "completed") ?? true;
        return (step.Status == "completed") == completed
            ? VendorActionResult.Skipped("VND_ALREADY_DONE", "The step is already so in Huntress; nothing was sent.")
            : null;
    }

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct)
    {
        var completed = Flag(context.Parameters, "completed") ?? true;
        await Client.SetRemediationCompletionAsync(incidentId, Number(context.Parameters, "remediation")!.Value, completed, ct);
        return VendorActionResult.Succeeded("VND_SENT", completed ? "Huntress marked the step done." : "Huntress marked the step not done.");
    }
}

/// <summary>
/// Resolves the report (<c>resolution</c>) once every remediation is approved. Assisted steps may still run and manual ones still wait
/// to be marked after it. The alert closes when the read after it shows the report closed.
/// </summary>
internal sealed class HuntressIncidentResolveAction(ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressIncidentAction(security, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Resolve;

    /// <summary>A person asked to close it: once Huntress accepted, or shows it closed already, nothing waits for another confirmation.</summary>
    protected override IncidentClosing Closing(bool sent) => sent ? IncidentClosing.Closed : IncidentClosing.MayClose;

    protected override VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters)
    {
        if (NotWaiting(incident, target) is { } blocked)
        {
            return blocked;
        }

        if (incident.Remediations.Any(r => r.Status == "unapproved"))
        {
            return VendorActionPlan.Blocked(target, "VND_INCIDENT_UNAPPROVED", "Approve or send back the remediations first: Huntress resolves only an approved plan.");
        }

        var effects = new List<VendorActionEffect> { Effect("VND_EFFECT_HUNTRESS_RESOLVE") };
        if (incident.Remediations.Any(r => r.Type == "manual" && r.Status != "completed"))
        {
            effects.Add(Effect("VND_EFFECT_HUNTRESS_RESOLVE_MANUAL"));
        }

        return new VendorActionPlan(target, effects, null, "{}");
    }

    protected override VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters) =>
        NotWaiting(live) ?? (plan.Any(r => r.Status == "unapproved")
            ? VendorActionResult.Rejected("VND_INCIDENT_UNAPPROVED", "A remediation waits for approval in Huntress; nothing was sent.")
            : null);

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct)
    {
        await Client.ResolveIncidentAsync(incidentId, ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress resolved the incident.");
    }
}

/// <summary>
/// A comment on the report: everyone of the account who sees it reads it; Huntress's SOC is not told and does not answer comments.
/// Not repeatable: Huntress has no key that would recognise the same comment sent twice.
/// </summary>
internal sealed class HuntressCommentAction(ISecurityApi security, ICustomersApi customers, IHuntressActionClient client, HuntressReadBack readBack)
    : HuntressIncidentAction(security, customers, client, readBack)
{
    public override string Kind => HuntressActionKinds.Comment;

    public override bool IsRepeatable => false;

    protected override bool ChangesComments => true;

    protected override VendorActionPlan Plan(IncidentView incident, VendorActionTarget target, JsonElement parameters)
    {
        var text = Text(parameters, "text")?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_REQUIRED", "Write the text first.");
        }

        if (text.Length > HuntressActionKinds.MaxTextLength)
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_TOO_LONG", $"The text is longer than {HuntressActionKinds.MaxTextLength} characters.");
        }

        return new VendorActionPlan(target, [Effect("VND_EFFECT_HUNTRESS_COMMENT"), Effect("VND_EFFECT_HUNTRESS_COMMENT_SOC")], null,
            VendorActionRules.Canonical(new Dictionary<string, object?> { ["text"] = text }));
    }

    protected override VendorActionResult? Check(HuntressIncident live, IReadOnlyList<HuntressRemediation> plan, JsonElement parameters) => null;

    protected override async Task<VendorActionResult> SendAsync(VendorActionContext context, long incidentId, CancellationToken ct)
    {
        var comment = await Client.CreateCommentAsync(incidentId, Text(context.Parameters, "text")!, ct);
        return VendorActionResult.Succeeded("VND_SENT", "Huntress added the comment.", comment?.Id.ToString(CultureInfo.InvariantCulture));
    }
}
