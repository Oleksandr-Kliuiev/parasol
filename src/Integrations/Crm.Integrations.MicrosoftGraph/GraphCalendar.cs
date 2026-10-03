using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Activities.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Meetings in the organizer's own Outlook calendar (FR-ACT-02). The CRM writes the activity id into an open extension,
/// so an event can be matched back to its activity without touching the subject the customer sees.
/// </summary>
internal sealed class GraphCalendar(HttpClient http, IOptions<GraphOptions> options) : IUserCalendar
{
    /// <summary>Name of the open extension that carries the CRM activity id (docs/05 §1.4).</summary>
    public const string ExtensionName = "no.vardahei.crm";

    public bool IsAvailable => options.Value.Enabled && options.Value.CalendarEnabled;

    public async Task<CalendarEventState> CreateAsync(CalendarEventDraft draft, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("me/events", Body(draft, includeExtension: true), cancellationToken);
        return Map(await ReadAsync(response, cancellationToken), draft.ActivityId);
    }

    public async Task<CalendarEventState> UpdateAsync(string eventId, CalendarEventDraft draft, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Patch, $"me/events/{Uri.EscapeDataString(eventId)}")
        {
            Content = JsonContent.Create(Body(draft, includeExtension: false)),
        };
        using var response = await http.SendAsync(request, cancellationToken);
        return Map(await ReadAsync(response, cancellationToken), draft.ActivityId);
    }

    public async Task CancelAsync(string eventId, CancellationToken cancellationToken)
    {
        // Deleting as the organizer sends the cancellation to the attendees; an event already gone is not an error.
        using var response = await http.DeleteAsync($"me/events/{Uri.EscapeDataString(eventId)}", cancellationToken);
        if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.Gone)
        {
            return;
        }

        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<IReadOnlyList<CalendarEventState>> ReadWindowAsync(DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        var url = string.Create(
            CultureInfo.InvariantCulture,
            $"me/calendarView?startDateTime={from.UtcDateTime:yyyy-MM-ddTHH:mm:ssZ}&endDateTime={to.UtcDateTime:yyyy-MM-ddTHH:mm:ssZ}" +
            $"&$select=id,subject,start,end,isCancelled,webLink&$expand=extensions($filter=id eq '{ExtensionName}')&$top=200");
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("Prefer", "outlook.timezone=\"UTC\"");
        using var response = await http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        var page = await response.Content.ReadFromJsonAsync<GraphEventPage>(cancellationToken);
        return (page?.Value ?? []).Select(e => Map(e, ActivityIdOf(e))).ToList();
    }

    internal static Guid? ActivityIdOf(GraphEvent graphEvent)
    {
        var extension = graphEvent.Extensions?.FirstOrDefault(e => e.ExtensionName == ExtensionName);
        if (extension?.ActivityId is { } value && Guid.TryParse(value, out var activityId))
        {
            return activityId;
        }

        return null;
    }

    internal static CalendarEventState Map(GraphEvent graphEvent, Guid? activityId) => new(
        graphEvent.Id,
        activityId,
        graphEvent.Subject ?? string.Empty,
        Parse(graphEvent.Start),
        Parse(graphEvent.End),
        graphEvent.IsCancelled ?? false,
        graphEvent.WebLink);

    /// <summary>Graph returns local time plus a zone name; the CRM works in UTC.</summary>
    internal static DateTimeOffset Parse(GraphDateTime? value)
    {
        if (value?.DateTime is not { Length: > 0 } text || !DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed))
        {
            return default;
        }

        var zone = value.TimeZone is { Length: > 0 } id && TryFindZone(id) is { } found ? found : TimeZoneInfo.Utc;
        return new DateTimeOffset(DateTime.SpecifyKind(parsed, DateTimeKind.Unspecified), zone.GetUtcOffset(parsed)).ToUniversalTime();
    }

    private static TimeZoneInfo? TryFindZone(string id)
    {
        try
        {
            return id is "UTC" ? TimeZoneInfo.Utc : TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (TimeZoneNotFoundException)
        {
            return null;
        }
        catch (InvalidTimeZoneException)
        {
            return null;
        }
    }

    private static Dictionary<string, object?> Body(CalendarEventDraft draft, bool includeExtension)
    {
        var body = new Dictionary<string, object?>
        {
            ["subject"] = draft.Subject,
            ["body"] = new { contentType = "HTML", content = System.Net.WebUtility.HtmlEncode(draft.Body ?? string.Empty).Replace("\n", "<br>", StringComparison.Ordinal) },
            ["start"] = new { dateTime = draft.StartsAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture), timeZone = "UTC" },
            ["end"] = new { dateTime = draft.EndsAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture), timeZone = "UTC" },
            ["attendees"] = draft.Attendees
                .Select(address => new { emailAddress = new { address }, type = "required" })
                .ToList(),
        };

        if (!string.IsNullOrWhiteSpace(draft.Location))
        {
            body["location"] = new { displayName = draft.Location };
        }

        if (includeExtension)
        {
            body["extensions"] = new[]
            {
                new Dictionary<string, object?>
                {
                    ["@odata.type"] = "microsoft.graph.openTypeExtension",
                    ["extensionName"] = ExtensionName,
                    ["activityId"] = draft.ActivityId.ToString(),
                },
            };
        }

        return body;
    }

    private static async Task<GraphEvent> ReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        await EnsureSuccessAsync(response, cancellationToken);
        return await response.Content.ReadFromJsonAsync<GraphEvent>(cancellationToken)
               ?? throw new HttpRequestException("Graph returned an empty event.");
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new HttpRequestException($"Graph calendar returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
    }
}

public sealed record GraphDateTime(
    [property: JsonPropertyName("dateTime")] string? DateTime,
    [property: JsonPropertyName("timeZone")] string? TimeZone);

public sealed record GraphOpenExtension(
    [property: JsonPropertyName("extensionName")] string? ExtensionName,
    [property: JsonPropertyName("activityId")] string? ActivityId);

public sealed record GraphEvent(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("subject")] string? Subject,
    [property: JsonPropertyName("start")] GraphDateTime? Start,
    [property: JsonPropertyName("end")] GraphDateTime? End,
    [property: JsonPropertyName("isCancelled")] bool? IsCancelled,
    [property: JsonPropertyName("webLink")] string? WebLink,
    [property: JsonPropertyName("extensions")] IReadOnlyList<GraphOpenExtension>? Extensions);

internal sealed record GraphEventPage([property: JsonPropertyName("value")] IReadOnlyList<GraphEvent> Value);
