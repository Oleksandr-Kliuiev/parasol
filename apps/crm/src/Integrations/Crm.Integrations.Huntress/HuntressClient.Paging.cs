using System.Net;
using System.Text.Json;

namespace Crm.Integrations.Huntress;

/// <summary>Huntress's paged lists: <c>limit</c> (at most 500) and the <c>page_token</c> the previous page names.</summary>
internal sealed partial class HuntressClient
{
    /// <summary>Pages after which a list is taken for one that never ends.</summary>
    private const int MaxPages = 10_000;

    /// <summary>
    /// Reads every page of a list. A list that changes while it is read could shift an item across a page boundary, so after each
    /// page the previous one is read once more by its token and items are yielded once. An item that cannot be read fails the
    /// read: the readers of agents, incidents and notices store what a complete read lists and close what it does not, so nothing
    /// may go missing quietly. A token Huntress names twice ends the read with an error instead of reading for ever.
    /// </summary>
    private async IAsyncEnumerable<T> GetPagedAsync<T>(
        string resource,
        string collection,
        Func<JsonElement, T?> read,
        string? filter,
        Func<T, long> key,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
        where T : class
    {
        var size = Math.Clamp(options.Value.PageSize, 1, 500);
        var seen = new HashSet<long>();
        var tokens = new HashSet<string>(StringComparer.Ordinal);
        string? previous = null;
        string? token = null;
        for (var page = 1; page <= MaxPages; page++)
        {
            var (items, next) = await ReadPageAsync(resource, collection, size, filter, token, read, cancellationToken);
            foreach (var item in items.Where(item => seen.Add(key(item))))
            {
                yield return item;
            }

            if (page > 1)
            {
                var (again, _) = await ReadPageAsync(resource, collection, size, filter, previous, read, cancellationToken);
                foreach (var item in again.Where(item => seen.Add(key(item))))
                {
                    yield return item;
                }
            }

            if (string.IsNullOrEmpty(next))
            {
                yield break;
            }

            if (!tokens.Add(next))
            {
                throw new HuntressApiException(HttpStatusCode.OK, $"Huntress {resource} named the same next page twice.");
            }

            previous = token;
            token = next;
        }

        throw new HuntressApiException(HttpStatusCode.OK, $"Huntress {resource} has more than {MaxPages} pages.");
    }

    private async Task<(List<T> Items, string? Next)> ReadPageAsync<T>(
        string resource, string collection, int size, string? filter, string? token, Func<JsonElement, T?> read, CancellationToken cancellationToken)
        where T : class
    {
        var query = $"{resource}?limit={size}{(filter is null ? string.Empty : "&" + filter)}{(token is null ? string.Empty : "&page_token=" + Uri.EscapeDataString(token))}";
        using var response = await http.GetAsync(query, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(collection, out var items) || items.ValueKind != JsonValueKind.Array)
        {
            throw new HuntressApiException(response.StatusCode, $"Unexpected Huntress response for {resource}: no {collection} array.");
        }

        var result = new List<T>();
        foreach (var element in items.EnumerateArray())
        {
            result.Add(read(element) ?? throw new HuntressApiException(response.StatusCode, $"Huntress {resource} holds an item that cannot be read."));
        }

        var next = root.TryGetProperty("pagination", out var pagination) && pagination.ValueKind == JsonValueKind.Object ? Text(pagination, "next_page_token") : null;
        return (result, next);
    }
}
