using System.Globalization;
using System.Text.Json;

namespace Crm.Integrations.Core.Actions;

/// <summary>
/// How much confirmation an action needs (M39.1). Standard: one button. Disruptive (the customer notices it: isolation, a paused
/// backup): a reason. Destructive (an agent or an organization removed, a restore over live data): a fresh sign-in, the target's
/// name typed, a reason and a hold during which it can still be cancelled.
/// </summary>
public enum VendorActionLevel
{
    Standard,
    Disruptive,
    Destructive,
}

/// <summary>Target types that every vendor's handlers share, so other parts of the CRM find the actions about one kind of record.</summary>
public static class VendorActionTargets
{
    /// <summary>A service desk ticket; the target id is the desk's ticket number (Atera now, others later).</summary>
    public const string Ticket = "ticket";

    /// <summary>An alert of a monitoring source (M40); the target id is the source's own alert id, as the mirror stores it.</summary>
    public const string Alert = "alert";

    /// <summary>An agent of a source on a customer's computer (M41: isolate, release, uninstall); the target id is the source's agent id.</summary>
    public const string Device = "device";

    /// <summary>
    /// A CRM organization that gets its counterpart at a vendor (M43: an Atera customer, a Huntress organization, a CloudAlly account);
    /// the target id is the organization's id, since the vendor has no id for it yet.
    /// </summary>
    public const string Organization = "organization";

    /// <summary>What an action's stored parameters become once its words are erased or past their retention (DEV-11).</summary>
    public const string ErasedParameters = "{}";

    /// <summary>
    /// The parameter that names the desk ticket an action concerns when its target is something else (hours recorded on a ticket), so
    /// the action's card and its notice lead to that ticket.
    /// </summary>
    public const string TicketParameter = "ticket";

    /// <summary>
    /// The desk ticket an action concerns: its target, or the ticket its parameters name; null when neither (or the parameters were
    /// already cleared by retention).
    /// </summary>
    public static long? TicketOf(VendorAction action)
    {
        if (action.TargetType == Ticket)
        {
            return long.TryParse(action.TargetId, NumberStyles.None, CultureInfo.InvariantCulture, out var target) ? target : null;
        }

        try
        {
            using var parameters = JsonDocument.Parse(action.Parameters);
            return parameters.RootElement.ValueKind == JsonValueKind.Object && parameters.RootElement.TryGetProperty(TicketParameter, out var ticket) &&
                ticket.ValueKind == JsonValueKind.Number && ticket.TryGetInt64(out var number) && number > 0
                ? number
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>Where one action stands. The last six are outcomes; only <see cref="Uncertain"/> waits for a person.</summary>
public enum VendorActionStatus
{
    /// <summary>A destructive action waits out its hold and can still be cancelled.</summary>
    Scheduled,

    /// <summary>Waiting for the worker, or for the vendor to answer again after a read that failed.</summary>
    Queued,

    /// <summary>The worker is reading the vendor and sending it now; at most one action per target is here.</summary>
    Sending,

    Succeeded,

    /// <summary>The vendor's switches say DryRun: the live state was read and nothing was sent.</summary>
    Simulated,

    /// <summary>The vendor already showed what was asked: nothing was sent.</summary>
    Skipped,

    /// <summary>A switch or the saved data refused it before anything was sent (writing off, kind not enabled, customer not allowed).</summary>
    Rejected,

    /// <summary>The vendor refused it, or it could not be prepared: nothing happened at the vendor.</summary>
    Failed,

    /// <summary>No clear answer after the request may have left: a person checks at the vendor and settles it.</summary>
    Uncertain,

    /// <summary>Withdrawn by a person before the worker took it.</summary>
    Cancelled,
}

/// <summary>
/// One action a person asked to be done at a vendor (<c>integration.VendorActions</c>, M39.1). It is saved together with the
/// <see cref="Persistence.OutboundOperation"/> that carries it (<c>action:{kind}</c>) in one transaction, so the action log and
/// the outbound queue never disagree about what was asked. The row is the action's journal: who asked, why, what the worker did.
/// <see cref="Parameters"/> may hold what a person wrote to a customer, so retention clears it; ids and outcomes stay.
/// </summary>
public sealed class VendorAction
{
    public const string EntityType = "VendorAction";

    /// <summary>The prefix of the outbound operations that carry actions; the minute-by-minute outbound job leaves them alone.</summary>
    public const string OperationPrefix = "action:";

    public Guid Id { get; init; }
    public required string System { get; init; }
    public required string Kind { get; init; }
    public VendorActionLevel Level { get; init; }
    public required string TargetType { get; init; }
    public required string TargetId { get; init; }

    /// <summary>The name of the target when the action was asked for (a ticket's number and title), as the log shows it.</summary>
    public required string TargetName { get; init; }

    public Guid? OrganizationId { get; init; }

    /// <summary>The vendor's id of the customer the target belongs to, checked against the vendor's allow-list.</summary>
    public string? ExternalCustomerId { get; init; }

    /// <summary>The validated parameters as canonical JSON; emptied to <c>{}</c> by retention.</summary>
    public required string Parameters { get; set; }

    /// <summary>What the preview token signed (<see cref="VendorActionRules.Fingerprint"/>): a repeated command must carry the same.</summary>
    public required string Fingerprint { get; init; }

    public string? Reason { get; init; }
    public Guid RequestedBy { get; init; }
    public DateTimeOffset RequestedAt { get; init; }

    /// <summary>Not sent before this: the request time, or the end of a destructive action's hold.</summary>
    public DateTimeOffset NotBefore { get; init; }

    /// <summary>The client's key for this command: a repeated request with it returns this action (unique per person).</summary>
    public Guid CommandKey { get; init; }

    public Guid OutboundOperationId { get; init; }
    public VendorActionStatus Status { get; set; }

    /// <summary>What happened, as a code the interface translates (<c>VND_SENT</c>, <c>VND_WRITE_DISABLED</c>, …).</summary>
    public string? OutcomeCode { get; set; }

    /// <summary>The same in English for logs and the API; written by the CRM, never a provider's text.</summary>
    public string? Outcome { get; set; }

    /// <summary>The vendor's id of what the action created (a comment), when it said.</summary>
    public string? Reference { get; set; }

    /// <summary>Set when an attempt ended without a clear answer: the request may have reached the vendor.</summary>
    public bool MayHaveSent { get; set; }

    public int Attempts { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    /// <summary>Who cancelled the action, or settled an uncertain one, and why; <see cref="ClosedAt"/> is when.</summary>
    public Guid? ClosedBy { get; set; }
    public DateTimeOffset? ClosedAt { get; set; }
    public string? CloseReason { get; set; }
    public byte[] RowVersion { get; set; } = [];

    public static string OperationFor(string kind) => OperationPrefix + kind;

    public bool IsFinished => Status is not (VendorActionStatus.Scheduled or VendorActionStatus.Queued or VendorActionStatus.Sending);
}
