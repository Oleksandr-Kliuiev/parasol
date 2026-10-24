using System.Net;
using System.Text.Json;

namespace Crm.Integrations.Atera;

/// <summary>Atera's paged lists.</summary>
internal sealed partial class AteraClient
{
    /// <summary>
    /// Reads a paged list. With <paramref name="key"/> the previous page is read once more after the next one: a list that changes
    /// while it is read (a ticket closing leaves a status-filtered list, a new one pushes the rest down) shifts items across the
    /// page boundary, and the overlap catches what moved to the tail of the page already read. Items are yielded once. A
    /// <paramref name="strict"/> read fails on an item it cannot understand instead of leaving it out.
    /// </summary>
    private async IAsyncEnumerable<T> GetPagedAsync<T>(
        string resource,
        Func<JsonElement, T?> read,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken,
        string? filter = null,
        Func<T, string>? key = null,
        bool strict = false)
        where T : class
    {
        var size = Math.Clamp(options.Value.ItemsInPage, 1, 50);
        var seen = key is null ? null : new HashSet<string>(StringComparer.Ordinal);
        for (int page = 1; page <= 100_000; page++)
        {
            var (items, last) = await ReadPageAsync(resource, page, size, filter, read, strict, cancellationToken);
            foreach (var item in items)
            {
                if (seen is null || seen.Add(key!(item)))
                {
                    yield return item;
                }
            }

            if (key is not null && page > 1)
            {
                var (previous, _) = await ReadPageAsync(resource, page - 1, size, filter, read, strict, cancellationToken);
                foreach (var item in previous)
                {
                    if (seen!.Add(key(item)))
                    {
                        yield return item;
                    }
                }
            }

            if (last)
            {
                yield break;
            }
        }

        throw new AteraApiException(HttpStatusCode.OK, $"Atera {resource} has more than 100000 pages.");
    }

    private async Task<(List<T> Items, bool Last)> ReadPageAsync<T>(
        string resource, int page, int size, string? filter, Func<JsonElement, T?> read, bool strict, CancellationToken cancellationToken)
        where T : class
    {
        using var response = await http.GetAsync($"{resource}?page={page}&itemsInPage={size}{(filter is null ? string.Empty : "&" + filter)}", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (!TryGet(root, out var items, "items", "Items") || items.ValueKind != JsonValueKind.Array)
        {
            throw new AteraApiException(response.StatusCode, $"Unexpected Atera response for {resource}: no items array.");
        }

        var result = new List<T>();
        foreach (var element in items.EnumerateArray())
        {
            if (read(element) is { } item)
            {
                result.Add(item);
            }
            else if (strict)
            {
                throw new AteraApiException(response.StatusCode, $"Atera {resource} page {page} holds an item that cannot be read.");
            }
        }

        var totalPages = Long(root, "totalPages", "TotalPages");
        return (result, items.GetArrayLength() < size || (totalPages is { } total && page >= total));
    }
}
