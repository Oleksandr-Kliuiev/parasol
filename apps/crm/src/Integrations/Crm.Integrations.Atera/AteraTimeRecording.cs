using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Integrations.Core.Actions;
using Crm.Service.Contracts;
using Crm.SharedKernel.Application;
using Crm.TimeTracking.Contracts;

namespace Crm.Integrations.Atera;

/// <summary>
/// The marker that ties an Atera work-hours row to the CRM time entry it was recorded from (M39.3). It travels in the row's comment,
/// so the work-hours import recognises the row as the CRM's own and does not count the hours a second time.
/// </summary>
public static partial class AteraTimeMarker
{
    public static string Of(Guid entryId) => $"[CRM-TE:{entryId:D}]";

    public static string Embed(string? description, Guid entryId) =>
        string.IsNullOrWhiteSpace(description) ? Of(entryId) : $"{description.TrimEnd()}\n\n{Of(entryId)}";

    /// <summary>The CRM entry a comment names, or null for a row someone recorded in Atera itself.</summary>
    public static Guid? Read(string? comment) =>
        comment is not null && Pattern().Match(comment) is { Success: true } match && Guid.TryParse(match.Groups[1].ValueSpan, out var id) ? id : null;

    [GeneratedRegex(@"\[CRM-TE:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]", RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 100)]
    private static partial Regex Pattern();
}

/// <summary>
/// Records a person's own CRM time entry as work hours on its Atera ticket (M39.3, <c>time.record</c>), written as their Atera
/// technician. What is sent is what the preview showed (ticket, window, billable, on site, comment), stored with the action. The
/// row carries the entry's marker: an attempt reads the ticket's work hours first and skips a row that is already there, so the
/// action is safe to repeat, and the import never counts the hours twice. A manual entry without times is recorded from 08:00 on
/// its work date (Oslo); the duration is the entry's.
/// </summary>
internal sealed class AteraTimeRecordAction(
    ITimeTrackingApi time, IServiceApi service, ICustomersApi customers, IAteraClient client, ITechnicianDirectory technicians, ICurrentUser user)
    : IVendorActionHandler
{
    public const string KindName = "time.record";
    public const string Target = "time-entry";
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public string System => AteraTypes.System;

    public string Kind => KindName;

    public string TargetType => Target;

    public VendorActionLevel Level => VendorActionLevel.Standard;

    public string Permission => Permissions.TimeOwn;

    public string ReadPermission => Permissions.TimeOwn;

    public bool IsRepeatable => true;

    public async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken ct)
    {
        if (!Guid.TryParse(request.TargetId, out var entryId) || await time.GetEntryForSendingAsync(entryId, ct) is not { } entry)
        {
            return VendorActionPlan.NotFound;
        }

        var ticket = entry.ExternalTicketId is { } number ? await service.GetTicketAsync(AteraTypes.System, number, ct) : null;
        var organization = (await customers.GetOrganizationNamesAsync([entry.OrganizationId], ct)).GetValueOrDefault(entry.OrganizationId);
        var hours = entry.Hours.ToString("0.##", CultureInfo.InvariantCulture);
        var target = new VendorActionTarget(Target, entry.Id.ToString("D"),
            entry.ExternalTicketId is { } shown ? $"{hours} h · #{shown} {entry.TicketTitle ?? ticket?.Title}".TrimEnd() : $"{hours} h",
            entry.OrganizationId, organization, ticket?.OwnerCustomerId?.ToString(CultureInfo.InvariantCulture), ticket?.Url);
        if (entry.Source != TimeSource.Crm)
        {
            return VendorActionPlan.Blocked(target, "VND_TIME_FROM_ATERA", "This entry came from Atera; it is already there.");
        }

        if (entry.TechnicianId is null || entry.TechnicianId != user.UserId)
        {
            return VendorActionPlan.Blocked(target, "VND_TIME_NOT_OWN", "Only the person whose time it is records it in Atera.");
        }

        if (ticket is null || ticket.OrganizationId != entry.OrganizationId)
        {
            return VendorActionPlan.Blocked(target, "VND_TIME_NO_TICKET", "The entry names no Atera ticket of its customer that the CRM knows.");
        }

        if (await TechnicianAsync(user.UserId, ct) is not { } technician)
        {
            return VendorActionPlan.Blocked(target, "VND_TECHNICIAN_UNMAPPED", "Your account is not linked to an Atera technician; link it under Technicians.");
        }

        var (start, end) = Window(entry);
        var local = (Start: TimeZoneInfo.ConvertTime(start, Oslo), End: TimeZoneInfo.ConvertTime(end, Oslo));
        var parameters = VendorActionRules.Canonical(new Dictionary<string, object?>
        {
            ["ticket"] = ticket.ExternalId,
            ["start"] = start.ToString("O", CultureInfo.InvariantCulture),
            ["end"] = end.ToString("O", CultureInfo.InvariantCulture),
            ["billable"] = entry.Billable,
            ["onsite"] = entry.Onsite,
            ["description"] = entry.Description,
        });
        return new VendorActionPlan(target,
        [
            new VendorActionEffect("VND_EFFECT_TIME_RECORD", new Dictionary<string, string?>
            {
                ["hours"] = hours, ["ticket"] = $"#{ticket.ExternalId}", ["date"] = local.Start.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture),
                ["from"] = local.Start.ToString("HH:mm", CultureInfo.InvariantCulture), ["to"] = local.End.ToString("HH:mm", CultureInfo.InvariantCulture),
            }),
            // A start the person did not give is said, not hidden in the times above.
            .. HasOwnTimes(entry) ? Array.Empty<VendorActionEffect>() : [new VendorActionEffect("VND_EFFECT_TIME_DEFAULT_START", new Dictionary<string, string?>
            {
                ["from"] = local.Start.ToString("HH:mm", CultureInfo.InvariantCulture),
            })],
            new VendorActionEffect(entry.Billable ? "VND_EFFECT_TIME_BILLABLE" : "VND_EFFECT_TIME_NOT_BILLABLE", new Dictionary<string, string?>()),
            new VendorActionEffect("VND_EFFECT_TICKET_AUTHOR", new Dictionary<string, string?> { ["name"] = technician.Name ?? technician.Email ?? technician.ExternalId }),
            new VendorActionEffect("VND_EFFECT_TIME_NO_DOUBLE", new Dictionary<string, string?>()),
        ], null, parameters);
    }

    public async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken ct)
    {
        var entryId = Guid.Parse(context.Action.TargetId);
        var ticketId = context.Parameters.GetProperty("ticket").GetInt64();
        AteraTicket? live;
        AteraWorkHoursResult recorded;
        try
        {
            live = await client.GetTicketAsync(ticketId, ct);
            recorded = live is null ? new AteraWorkHoursResult([], 0) : await client.GetWorkHoursAsync(ticketId, ct);
        }
        catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, ct))
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

        // An earlier attempt whose answer was lost, or a person who asked twice: the row is already there.
        if (recorded.Records.FirstOrDefault(r => AteraTimeMarker.Read(r.Description) == entryId) is { } existing)
        {
            return VendorActionResult.Skipped("VND_ALREADY_DONE", "Atera already has these hours; nothing was sent.") with { Reference = existing.Id };
        }

        if (await TechnicianAsync(context.Action.RequestedBy, ct) is not { } technician)
        {
            return VendorActionResult.Rejected("VND_TECHNICIAN_UNMAPPED", "The person who asked is no longer linked to an Atera technician; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode (DryRun): the hours were not recorded in Atera.");
        }

        var parameters = context.Parameters;
        var description = parameters.TryGetProperty("description", out var text) && text.ValueKind == JsonValueKind.String ? text.GetString() : null;
        try
        {
            var reference = await client.CreateWorkHoursAsync(ticketId, new AteraWorkHoursWrite(
                parameters.GetProperty("start").GetDateTimeOffset(), parameters.GetProperty("end").GetDateTimeOffset(),
                long.Parse(technician.ExternalId, CultureInfo.InvariantCulture), technician.Email, parameters.GetProperty("billable").GetBoolean(),
                parameters.GetProperty("onsite").GetBoolean(), AteraTimeMarker.Embed(description, entryId)), ct);
            return VendorActionResult.Succeeded("VND_SENT", "The hours were recorded in Atera.", reference);
        }
        catch (AteraApiException refused) when (AteraCreateTicketHandler.IsRejection(refused.Status))
        {
            return VendorActionResult.Failed("VND_VENDOR_REFUSED", $"Atera refused the hours ({(int)refused.Status}); nothing was recorded.");
        }
    }

    private static bool HasOwnTimes(TimeEntryForSending entry) => entry.StartedAt is { } started && entry.EndedAt is { } ended && ended > started;

    /// <summary>The entry's own times, or 08:00 on its work date in Oslo for the entry's duration.</summary>
    internal static (DateTimeOffset Start, DateTimeOffset End) Window(TimeEntryForSending entry)
    {
        if (HasOwnTimes(entry))
        {
            return (entry.StartedAt!.Value, entry.EndedAt!.Value);
        }

        var start = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(entry.WorkDate.ToDateTime(new TimeOnly(8, 0)), Oslo), TimeSpan.Zero);
        return (start, start.AddMinutes((double)decimal.Round(entry.Hours * 60m, 0)));
    }

    private async Task<TechnicianListing?> TechnicianAsync(Guid? userId, CancellationToken ct) =>
        userId is not { } id ? null : (await technicians.ListAsync(AteraTypes.System, ct))
            .FirstOrDefault(t => t.UserId == id && long.TryParse(t.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number > 0);
}
