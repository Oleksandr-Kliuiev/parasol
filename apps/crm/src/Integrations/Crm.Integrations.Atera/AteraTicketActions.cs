using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core.Actions;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>The ticket actions (M39.2) and the values Atera's standard ticket fields take.</summary>
public static class AteraTicketKinds
{
    public const string TargetType = "ticket";
    public const string Reply = "ticket.reply";
    public const string Note = "ticket.note";
    public const string Status = "ticket.status";
    public const string Priority = "ticket.priority";
    public const string Technician = "ticket.technician";
    public const string Close = "ticket.close";
    public const string Closed = "Closed";
    public const int MaxTextLength = 8000;

    public static readonly string[] Statuses = ["Open", "Pending", "Resolved", Closed];
    public static readonly string[] Priorities = ["Low", "Medium", "High", "Critical"];

    public static readonly string[] All = [Reply, Note, Status, Priority, Technician, Close];
}

/// <summary>Atera's write switches for the action path, read again for every preview, request and attempt (M39.1).</summary>
internal sealed class AteraActionGate(IOptionsMonitor<AteraOptions> options) : IVendorActionGate
{
    public string System => AteraTypes.System;

    public VendorActionSwitches Read()
    {
        var o = options.CurrentValue;
        return new VendorActionSwitches(o.Enabled, o.IsConfigured, o.WriteEnabled, o.DryRun, o.WriteAllowedCustomerIds, o.EnabledActions);
    }
}

/// <summary>
/// What every ticket action shares: the target is the CRM's saved copy of the ticket (its number and title, its customer, the Atera
/// customer it was read under, for the allow-list); the attempt starts by reading the ticket from Atera, refuses a ticket that left
/// for another customer, and reads the ticket back into the mirror once the change is made.
/// </summary>
internal abstract class AteraTicketAction(IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader) : IVendorActionHandler
{
    public string System => AteraTypes.System;

    public abstract string Kind { get; }

    public string TargetType => AteraTicketKinds.TargetType;

    public VendorActionLevel Level => VendorActionLevel.Standard;

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    public abstract bool IsRepeatable { get; }

    protected IAteraClient Client => client;

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (!long.TryParse(request.TargetId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) ||
            await service.GetTicketAsync(AteraTypes.System, id, cancellationToken) is not { } ticket)
        {
            return VendorActionPlan.NotFound;
        }

        var organization = (await customers.GetOrganizationNamesAsync([ticket.OrganizationId], cancellationToken)).GetValueOrDefault(ticket.OrganizationId);
        var target = new VendorActionTarget(AteraTicketKinds.TargetType, id.ToString(CultureInfo.InvariantCulture), $"#{id} {ticket.Title}",
            ticket.OrganizationId, organization, ticket.OwnerCustomerId?.ToString(CultureInfo.InvariantCulture), ticket.Url);
        return await PlanAsync(ticket, target, request.Parameters, cancellationToken);
    }

    protected abstract Task<VendorActionPlan> PlanAsync(TicketView ticket, VendorActionTarget target, JsonElement parameters, CancellationToken ct);

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var id = long.Parse(context.Action.TargetId, CultureInfo.InvariantCulture);
        AteraTicket? live;
        try
        {
            live = await client.GetTicketAsync(id, cancellationToken);
        }
        catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_VENDOR_BUSY", "Atera could not be read before sending; nothing was sent.");
        }

        if (live is null)
        {
            return VendorActionResult.Failed("VND_TARGET_GONE", "The ticket no longer exists in Atera; nothing was sent.");
        }

        if (context.Action.ExternalCustomerId is { } customer && live.CustomerId?.ToString(CultureInfo.InvariantCulture) != customer)
        {
            return VendorActionResult.Rejected("VND_TICKET_MOVED", "The ticket belongs to another customer in Atera now; nothing was sent.");
        }

        VendorActionResult result;
        try
        {
            result = await ExecuteAsync(context, live, cancellationToken);
        }
        catch (AteraApiException refused) when (AteraCreateTicketHandler.IsRejection(refused.Status))
        {
            // Atera answered and refused: nothing changed. Timeouts, conflicts and 5xx prove nothing and stay with the runner.
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Atera refused it ({(int)refused.Status}); nothing changed.");
        }

        if (result.Status == VendorActionStatus.Succeeded)
        {
            await reader.RefreshAsync(id, conversation: WritesConversation, cancellationToken);
        }

        return result;
    }

    /// <summary>Whether the action adds to the conversation, so the read-back reads the comments too.</summary>
    protected virtual bool WritesConversation => false;

    protected abstract Task<VendorActionResult> ExecuteAsync(VendorActionContext context, AteraTicket live, CancellationToken ct);

    protected static string? Text(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    protected static VendorActionEffect Effect(string code, params (string Name, string? Value)[] values) =>
        new(code, values.ToDictionary(v => v.Name, v => v.Value));

    /// <summary>The Atera technician a CRM user writes as: the mapping with a numeric Atera id (an e-mail key cannot sign a comment).</summary>
    protected static async Task<TechnicianListing?> TechnicianOfAsync(ITechnicianDirectory technicians, Guid? userId, CancellationToken ct) =>
        userId is not { } id ? null : (await technicians.ListAsync(AteraTypes.System, ct))
            .FirstOrDefault(t => t.UserId == id && long.TryParse(t.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number > 0);
}

/// <summary>
/// A reply the customer sees (<c>ticket.reply</c>) or an internal note only technicians see (<c>ticket.note</c>), written as the Atera
/// technician the person is mapped to. Not repeatable: Atera has no key that would recognise the same comment sent twice, so an
/// attempt without an answer waits for a person.
/// </summary>
internal sealed class AteraTicketCommentAction(
    bool isInternal, IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader,
    ITechnicianDirectory technicians, ICurrentUser user, TimeProvider time)
    : AteraTicketAction(service, customers, client, reader)
{
    public override string Kind => isInternal ? AteraTicketKinds.Note : AteraTicketKinds.Reply;

    public override bool IsRepeatable => false;

    protected override bool WritesConversation => true;

    protected override async Task<VendorActionPlan> PlanAsync(TicketView ticket, VendorActionTarget target, JsonElement parameters, CancellationToken ct)
    {
        var text = Text(parameters, "text")?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_REQUIRED", "Write the text first.");
        }

        if (text.Length > AteraTicketKinds.MaxTextLength)
        {
            return VendorActionPlan.Blocked(target, "VND_TEXT_TOO_LONG", $"The text is longer than {AteraTicketKinds.MaxTextLength} characters.");
        }

        if (await TechnicianOfAsync(technicians, user.UserId, ct) is not { } technician)
        {
            return VendorActionPlan.Blocked(target, "VND_TECHNICIAN_UNMAPPED", "Your account is not linked to an Atera technician; link it under Technicians.");
        }

        var effects = new List<VendorActionEffect>
        {
            isInternal
                ? Effect("VND_EFFECT_TICKET_NOTE")
                : Effect("VND_EFFECT_TICKET_REPLY", ("to", ticket.EndUserName ?? ticket.EndUserEmail)),
            Effect("VND_EFFECT_TICKET_AUTHOR", ("name", technician.Name ?? technician.Email)),
        };
        if (!isInternal && !ticket.IsOpen)
        {
            effects.Add(Effect("VND_EFFECT_TICKET_REOPEN", ("status", ticket.Status)));
        }

        return new VendorActionPlan(target, effects, null, VendorActionRules.Canonical(new Dictionary<string, object?> { ["text"] = text }));
    }

    protected override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, AteraTicket live, CancellationToken ct)
    {
        if (await TechnicianOfAsync(technicians, context.Action.RequestedBy, ct) is not { } technician)
        {
            return VendorActionResult.Rejected("VND_TECHNICIAN_UNMAPPED", "The person who asked is no longer linked to an Atera technician; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode (DryRun): the comment was not sent.");
        }

        var reference = await Client.CreateTicketCommentAsync(live.TicketId, new AteraCommentWrite(
            Text(context.Parameters, "text")!, long.Parse(technician.ExternalId, CultureInfo.InvariantCulture), isInternal, time.GetUtcNow()), ct);
        return VendorActionResult.Succeeded("VND_SENT", isInternal ? "The note was added in Atera." : "The reply was sent in Atera.", reference);
    }
}

/// <summary>
/// A change of one ticket field: status, priority or technician; closing is the status <c>Closed</c>. Repeatable: setting a field to
/// a value twice is the value once, so an attempt without an answer is decided by reading the ticket again.
/// </summary>
internal abstract class AteraTicketFieldAction(IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader)
    : AteraTicketAction(service, customers, client, reader)
{
    public override bool IsRepeatable => true;

    /// <summary>The field's value at Atera now, the value asked for, and the update that sets it.</summary>
    protected abstract (string? Live, string Wanted, AteraTicketUpdate Update) Compare(AteraTicket live, JsonElement parameters);

    protected override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, AteraTicket live, CancellationToken ct)
    {
        var (current, wanted, update) = Compare(live, context.Parameters);
        if (string.Equals(current, wanted, StringComparison.OrdinalIgnoreCase))
        {
            return VendorActionResult.Skipped("VND_ALREADY_DONE", "Atera already shows it; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", $"Test mode (DryRun): Atera would change {current ?? "nothing"} to {wanted}; nothing was sent.");
        }

        await Client.UpdateTicketAsync(live.TicketId, update, ct);
        return VendorActionResult.Succeeded("VND_SENT", "The ticket was changed in Atera.");
    }

    /// <summary>One of <paramref name="allowed"/>, spelled as Atera spells it; null for any other value.</summary>
    protected static string? Pick(string? value, string[] allowed) =>
        allowed.FirstOrDefault(a => string.Equals(a, value?.Trim(), StringComparison.OrdinalIgnoreCase));
}

internal sealed class AteraTicketStatusAction(bool close, IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader)
    : AteraTicketFieldAction(service, customers, client, reader)
{
    public override string Kind => close ? AteraTicketKinds.Close : AteraTicketKinds.Status;

    protected override Task<VendorActionPlan> PlanAsync(TicketView ticket, VendorActionTarget target, JsonElement parameters, CancellationToken ct)
    {
        var status = close ? AteraTicketKinds.Closed : Pick(Text(parameters, "status"), AteraTicketKinds.Statuses);
        if (status is null)
        {
            return Task.FromResult(VendorActionPlan.Blocked(target, "VND_VALUE_UNKNOWN", "Choose one of the statuses Atera knows."));
        }

        if (string.Equals(ticket.Status, status, StringComparison.OrdinalIgnoreCase))
        {
            return Task.FromResult(VendorActionPlan.Blocked(target, "VND_NO_CHANGE", "The ticket already has this status."));
        }

        var effects = new List<VendorActionEffect> { Effect("VND_EFFECT_TICKET_STATUS", ("from", ticket.Status), ("to", status)) };
        if (status is AteraTicketKinds.Closed or "Resolved")
        {
            effects.Add(Effect("VND_EFFECT_TICKET_CLOSE_NOTICE"));
        }

        return Task.FromResult(new VendorActionPlan(target, effects, null,
            close ? "{}" : VendorActionRules.Canonical(new Dictionary<string, object?> { ["status"] = status })));
    }

    protected override (string? Live, string Wanted, AteraTicketUpdate Update) Compare(AteraTicket live, JsonElement parameters)
    {
        var status = close ? AteraTicketKinds.Closed : Text(parameters, "status")!;
        return (live.Status, status, new AteraTicketUpdate(Status: status));
    }
}

internal sealed class AteraTicketPriorityAction(IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader)
    : AteraTicketFieldAction(service, customers, client, reader)
{
    public override string Kind => AteraTicketKinds.Priority;

    protected override Task<VendorActionPlan> PlanAsync(TicketView ticket, VendorActionTarget target, JsonElement parameters, CancellationToken ct)
    {
        if (Pick(Text(parameters, "priority"), AteraTicketKinds.Priorities) is not { } priority)
        {
            return Task.FromResult(VendorActionPlan.Blocked(target, "VND_VALUE_UNKNOWN", "Choose one of the priorities Atera knows."));
        }

        return Task.FromResult(string.Equals(ticket.Priority, priority, StringComparison.OrdinalIgnoreCase)
            ? VendorActionPlan.Blocked(target, "VND_NO_CHANGE", "The ticket already has this priority.")
            : new VendorActionPlan(target, [Effect("VND_EFFECT_TICKET_PRIORITY", ("from", ticket.Priority), ("to", priority))], null,
                VendorActionRules.Canonical(new Dictionary<string, object?> { ["priority"] = priority })));
    }

    protected override (string? Live, string Wanted, AteraTicketUpdate Update) Compare(AteraTicket live, JsonElement parameters)
    {
        var priority = Text(parameters, "priority")!;
        return (live.Priority, priority, new AteraTicketUpdate(Priority: priority));
    }
}

/// <summary>Gives the ticket to another Atera technician, chosen among the technicians the CRM has seen with a numeric Atera id.</summary>
internal sealed class AteraTicketTechnicianAction(
    IServiceApi service, ICustomersApi customers, IAteraClient client, AteraConversationReader reader, ITechnicianDirectory technicians)
    : AteraTicketFieldAction(service, customers, client, reader)
{
    public override string Kind => AteraTicketKinds.Technician;

    protected override async Task<VendorActionPlan> PlanAsync(TicketView ticket, VendorActionTarget target, JsonElement parameters, CancellationToken ct)
    {
        var wanted = Text(parameters, "technicianId")?.Trim();
        var known = (await technicians.ListAsync(AteraTypes.System, ct)).FirstOrDefault(t => t.ExternalId == wanted &&
            long.TryParse(t.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number > 0);
        if (known is null)
        {
            return VendorActionPlan.Blocked(target, "VND_TECHNICIAN_UNKNOWN", "Choose a technician Atera knows.");
        }

        return string.Equals(ticket.TechnicianName, known.Name, StringComparison.OrdinalIgnoreCase) && known.UserId == ticket.TechnicianUserId
            ? VendorActionPlan.Blocked(target, "VND_NO_CHANGE", "The ticket already has this technician.")
            : new VendorActionPlan(target, [Effect("VND_EFFECT_TICKET_TECHNICIAN", ("from", ticket.TechnicianName), ("to", known.Name ?? known.Email))], null,
                VendorActionRules.Canonical(new Dictionary<string, object?> { ["technicianId"] = known.ExternalId }));
    }

    protected override (string? Live, string Wanted, AteraTicketUpdate Update) Compare(AteraTicket live, JsonElement parameters)
    {
        var wanted = Text(parameters, "technicianId")!;
        return (live.TechnicianId?.ToString(CultureInfo.InvariantCulture), wanted,
            new AteraTicketUpdate(TechnicianContactId: long.Parse(wanted, CultureInfo.InvariantCulture)));
    }
}
