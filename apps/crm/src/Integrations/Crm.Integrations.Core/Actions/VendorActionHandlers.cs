using System.Text.Json;

namespace Crm.Integrations.Core.Actions;

/// <summary>What a person asks for, before anything is saved: the vendor, the kind, the target and the kind's own parameters.</summary>
public sealed record VendorActionRequest(string System, string Kind, string TargetType, string TargetId, JsonElement Parameters);

/// <summary>
/// The thing an action changes, as the CRM's saved copy knows it. <paramref name="Name"/> is what a destructive action asks to
/// be typed; <paramref name="Url"/> leads to it at the vendor when the integration has a configured link.
/// </summary>
public sealed record VendorActionTarget(
    string Type, string Id, string Name, Guid? OrganizationId, string? OrganizationName, string? ExternalCustomerId, string? Url);

/// <summary>One consequence of an action, as a code the interface translates and the values it names (old and new status).</summary>
public sealed record VendorActionEffect(string Code, IReadOnlyDictionary<string, string?> Values);

/// <summary>Why an action cannot be asked for now: a code the interface translates and the same in English.</summary>
public sealed record VendorActionBlock(string Code, string Message);

/// <summary>
/// The preview of one action, made from saved data only: the target (null when the saved copy has no such target), the effects,
/// what blocks it, and the parameters in canonical form — those are what is stored and signed.
/// </summary>
public sealed record VendorActionPlan(
    VendorActionTarget? Target, IReadOnlyList<VendorActionEffect> Effects, VendorActionBlock? Block, string CanonicalParameters)
{
    public static VendorActionPlan NotFound { get; } = new(null, [], null, "{}");

    public static VendorActionPlan Blocked(VendorActionTarget? target, string code, string message) =>
        new(target, [], new VendorActionBlock(code, message), "{}");
}

/// <summary>The saved action with its parameters parsed, as the worker hands it to the handler.</summary>
public sealed record VendorActionContext(VendorAction Action, JsonElement Parameters, bool Simulate);

/// <summary>
/// What an attempt came to. <see cref="Retry"/> means nothing happened at the vendor that a repeat would double (a read failed,
/// the vendor was busy), so the worker tries again later; the others are outcomes.
/// </summary>
public sealed record VendorActionResult(VendorActionStatus Status, string Code, string Message, string? Reference = null, bool Retry = false)
{
    public static VendorActionResult Succeeded(string code, string message, string? reference = null) => new(VendorActionStatus.Succeeded, code, message, reference);

    public static VendorActionResult Simulated(string code, string message) => new(VendorActionStatus.Simulated, code, message);

    public static VendorActionResult Skipped(string code, string message) => new(VendorActionStatus.Skipped, code, message);

    public static VendorActionResult Rejected(string code, string message) => new(VendorActionStatus.Rejected, code, message);

    public static VendorActionResult Failed(string code, string message) => new(VendorActionStatus.Failed, code, message);

    public static VendorActionResult Uncertain(string code, string message) => new(VendorActionStatus.Uncertain, code, message);

    public static VendorActionResult Later(string code, string message) => new(VendorActionStatus.Queued, code, message, Retry: true);
}

/// <summary>
/// One kind of action at one vendor (M39.1), registered by its integration. The preview runs in crm-web from saved data only (no
/// provider credentials there); the execution runs in crm-worker and starts by reading the vendor's live state, so a change that
/// is already there is skipped instead of sent again.
/// </summary>
public interface IVendorActionHandler
{
    string System { get; }

    /// <summary>The kind's name, e.g. <c>ticket.reply</c>; new kinds stay off until the vendor's <c>EnabledActions</c> lists them.</summary>
    string Kind { get; }

    string TargetType { get; }

    VendorActionLevel Level { get; }

    /// <summary>The permission to ask for, cancel and settle it; reading the log of the kind needs <see cref="ReadPermission"/>.</summary>
    string Permission { get; }

    string ReadPermission { get; }

    /// <summary>
    /// Repeating the request cannot double its effect (setting a status or a priority): an attempt that got no answer is tried again
    /// after reading the vendor, instead of waiting for a person. A comment is not repeatable.
    /// </summary>
    bool IsRepeatable { get; }

    /// <summary>From saved data only: no provider call. Invalid parameters block the action with a code.</summary>
    Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken);

    /// <summary>
    /// In crm-worker, after the switches allowed it: reads the vendor's live state, then sends (or, when simulating, says what it
    /// would send). Expected outcomes are returned; an exception means the outcome is unknown.
    /// </summary>
    Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken);
}

/// <summary>
/// The write switches of one vendor (M39.1), read again for every preview, request and attempt so a changed setting counts at
/// once: <c>WriteEnabled</c>, <c>DryRun</c>, the customer allow-list (empty = every customer) and <c>EnabledActions</c>.
/// </summary>
public interface IVendorActionGate
{
    string System { get; }

    VendorActionSwitches Read();
}

/// <summary>
/// <paramref name="Enabled"/> is the integration's switch; <paramref name="Configured"/> also needs the credentials, which only
/// crm-worker holds, so crm-web leaves it to the worker.
/// </summary>
public sealed record VendorActionSwitches(
    bool Enabled, bool Configured, bool WriteEnabled, bool DryRun, IReadOnlyCollection<string> AllowedCustomerIds, IReadOnlyCollection<string> EnabledActions);
