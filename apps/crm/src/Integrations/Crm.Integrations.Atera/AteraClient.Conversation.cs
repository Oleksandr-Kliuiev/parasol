using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crm.Integrations.Atera;

/// <summary>
/// A ticket's conversation and the changes the CRM makes to a ticket (M39.2, M39.3). The routes and fields follow Atera's v3 API
/// as the PSAtera module and Atera's community describe it; the exact contract is confirmed on the company's account (EXT-03).
/// </summary>
internal sealed partial class AteraClient
{
    /// <summary>Upper bound for one ticket's comment pages; reaching it is an error, not the end of the conversation.</summary>
    private const int MaxCommentPages = 100;

    public async Task<AteraTicket?> GetTicketAsync(long ticketId, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"tickets/{ticketId}", cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return ReadTicket(document.RootElement)
               ?? throw new AteraApiException(response.StatusCode, $"Atera answered for ticket {ticketId} without a ticket id.");
    }

    public IAsyncEnumerable<AteraTicket> GetModifiedTicketsAsync(DateTimeOffset since, CancellationToken cancellationToken) =>
        GetPagedAsync("tickets/lastmodified", ReadTicket, cancellationToken,
            $"date={Uri.EscapeDataString(since.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture))}&includeComments=false", TicketKey, strict: true);

    public async Task<IReadOnlyList<AteraComment>> GetTicketCommentsAsync(long ticketId, CancellationToken cancellationToken)
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        var comments = new List<AteraComment>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var page = 1; ; page++)
        {
            if (page > MaxCommentPages)
            {
                throw new AteraApiException(HttpStatusCode.OK, $"Comments of ticket {ticketId} span more than {MaxCommentPages} pages.");
            }

            using var response = await http.GetAsync($"tickets/{ticketId}/comments?page={page}&itemsInPage={size}", cancellationToken);
            if (response.StatusCode is HttpStatusCode.NoContent)
            {
                return comments;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = document.RootElement;
            // A bare array is one page; the usual envelope says how many pages there are.
            var items = root.ValueKind == JsonValueKind.Array ? root : TryGet(root, out var wrapped, "items", "Items") ? wrapped : default;
            if (items.ValueKind != JsonValueKind.Array)
            {
                throw new AteraApiException(response.StatusCode, $"Unexpected Atera response for the comments of ticket {ticketId}: no items array.");
            }

            foreach (var element in items.EnumerateArray())
            {
                // The CRM keeps the conversation it shows complete: an entry it cannot read fails the read instead of disappearing.
                var comment = ReadComment(element, ticketId)
                              ?? throw new AteraApiException(response.StatusCode, $"Atera comments of ticket {ticketId} hold an entry that cannot be read.");
                if (seen.Add(comment.CommentId))
                {
                    comments.Add(comment);
                }
            }

            var totalPages = root.ValueKind == JsonValueKind.Object ? Long(root, "totalPages", "TotalPages") : null;
            if (root.ValueKind == JsonValueKind.Array || items.GetArrayLength() < size || totalPages is not { } total || page >= total)
            {
                return comments;
            }
        }
    }

    public async Task<string?> CreateTicketCommentAsync(long ticketId, AteraCommentWrite comment, CancellationToken cancellationToken)
    {
        // Names as Atera's v3 API spells them: the technician's details carry whether the customer sees the comment.
        var body = new Dictionary<string, object?>
        {
            ["CommentText"] = comment.Text,
            ["CommentTimestampUTC"] = comment.At.UtcDateTime,
            ["TechnicianCommentDetails"] = new Dictionary<string, object?>
            {
                ["TechnicianId"] = comment.TechnicianId,
                ["IsInternal"] = comment.IsInternal,
            },
        };
        using var response = await http.PostAsJsonAsync($"tickets/{ticketId}/comments", body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await ReadCreatedIdAsync(response, cancellationToken, "ActionID", "CommentID", "id");
    }

    public async Task UpdateTicketAsync(long ticketId, AteraTicketUpdate update, CancellationToken cancellationToken)
    {
        // Atera updates a ticket with a POST of the fields to change; a field left out keeps its value.
        var body = new Dictionary<string, object?>();
        if (update.Status is { } status)
        {
            body["TicketStatus"] = status;
        }

        if (update.Priority is { } priority)
        {
            body["TicketPriority"] = priority;
        }

        if (update.TechnicianContactId is { } technician)
        {
            body["TechnicianContactID"] = technician;
        }

        if (body.Count == 0)
        {
            throw new ArgumentException("An update must change at least one field.", nameof(update));
        }

        using var response = await http.PostAsJsonAsync($"tickets/{ticketId}", body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<string?> CreateWorkHoursAsync(long ticketId, AteraWorkHoursWrite hours, CancellationToken cancellationToken)
    {
        // "Billiable" is Atera's own spelling of the field (PSAtera sends it so).
        var body = new Dictionary<string, object?>
        {
            ["StartWorkHour"] = hours.Start.UtcDateTime,
            ["EndWorkHour"] = hours.End.UtcDateTime,
            ["TechnicianContactID"] = hours.TechnicianId,
            ["Billiable"] = hours.Billable,
            ["OnCustomerSite"] = hours.OnSite,
        };
        if (!string.IsNullOrWhiteSpace(hours.TechnicianEmail))
        {
            body["TechnicianEmail"] = hours.TechnicianEmail;
        }

        if (!string.IsNullOrWhiteSpace(hours.Comments))
        {
            body["Comments"] = hours.Comments;
        }

        using var response = await http.PostAsJsonAsync($"tickets/{ticketId}/workhours", body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        return await ReadCreatedIdAsync(response, cancellationToken, "ActionID", "WorkHoursID", "id");
    }

    /// <summary>The id in a create's answer; an empty or non-JSON answer is a success without one.</summary>
    private static async Task<string?> ReadCreatedIdAsync(HttpResponseMessage response, CancellationToken cancellationToken, params string[] names)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object ? Text(document.RootElement, names) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
