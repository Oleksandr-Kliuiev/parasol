using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Crm.Integrations.Atera;

/// <summary>Tickets and their work hours.</summary>
internal sealed partial class AteraClient
{
    public IAsyncEnumerable<AteraTicket> GetTicketsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("tickets", ReadTicket, cancellationToken, status is null ? null : $"ticketStatus={Uri.EscapeDataString(status)}", TicketKey);

    public IAsyncEnumerable<AteraTicket> GetCustomerTicketsAsync(long customerId, CancellationToken cancellationToken) =>
        GetPagedAsync($"tickets/customer/{customerId}", ReadTicket, cancellationToken, null, TicketKey);

    private static string TicketKey(AteraTicket ticket) => ticket.TicketId.ToString(CultureInfo.InvariantCulture);

    /// <summary>Upper bound for one ticket's work-hour pages; reaching it is an error, not the end of the list.</summary>
    private const int MaxWorkHourPages = 200;

    public async Task<AteraWorkHoursResult> GetWorkHoursAsync(long ticketId, CancellationToken cancellationToken)
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        var records = new List<AteraWorkHours>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var dropped = 0;
        string? next = $"tickets/{ticketId}/workhoursrecords?page=1&itemsInPage={size}";
        for (var page = 1; next is not null; page++)
        {
            if (page > MaxWorkHourPages)
            {
                throw new AteraApiException(HttpStatusCode.OK, $"Work hours of ticket {ticketId} span more than {MaxWorkHourPages} pages.");
            }

            using var response = await http.GetAsync(next, cancellationToken);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.NoContent)
            {
                break;
            }

            await EnsureSuccessAsync(response, cancellationToken);
            using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            var root = document.RootElement;
            // Work hours come back either as a bare array (one page) or wrapped in the usual paged envelope.
            var items = root.ValueKind == JsonValueKind.Array ? root : TryGet(root, out var wrapped, "items", "Items") ? wrapped : default;
            if (items.ValueKind != JsonValueKind.Array)
            {
                break;
            }

            foreach (var element in items.EnumerateArray())
            {
                if (ReadWorkHours(element, ticketId) is { } hours)
                {
                    if (seen.Add(hours.Id))
                    {
                        records.Add(hours);
                    }
                }
                else
                {
                    dropped++;
                }
            }

            next = root.ValueKind == JsonValueKind.Object ? NextPage(root, page, size, items.GetArrayLength(), ticketId) : null;
        }

        return new AteraWorkHoursResult(records, dropped);
    }

    /// <summary>The page after this one: the envelope's <c>nextLink</c> when it has one, else the next number while <c>totalPages</c> says there is more.</summary>
    private string? NextPage(JsonElement root, int page, int size, int count, long ticketId)
    {
        if (Text(root, "nextLink", "NextLink") is { } link)
        {
            // Followed only on Atera's own host: the client's base address decides where requests go.
            if (!Uri.TryCreate(link, UriKind.Absolute, out var absolute))
            {
                return link.TrimStart('/');
            }

            var basePath = http.BaseAddress?.AbsolutePath ?? "/";
            return absolute.PathAndQuery.StartsWith(basePath, StringComparison.OrdinalIgnoreCase) ? absolute.PathAndQuery[basePath.Length..] : absolute.PathAndQuery.TrimStart('/');
        }

        var totalPages = Long(root, "totalPages", "TotalPages");
        return totalPages is { } total && page < total && count > 0
            ? $"tickets/{ticketId}/workhoursrecords?page={page + 1}&itemsInPage={size}"
            : null;
    }

    public async Task<long> CreateTicketAsync(AteraTicketWrite ticket, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync("tickets", ticket, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        return Long(document.RootElement, "ActionID", "TicketID", "id")
               ?? throw new AteraApiException(response.StatusCode, "Atera did not return the id of the created ticket.");
    }
}
