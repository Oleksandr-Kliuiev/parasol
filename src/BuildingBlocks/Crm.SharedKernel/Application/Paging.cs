using System.Buffers.Text;
using System.Text.Json;

namespace Crm.SharedKernel.Application;

/// <summary>
/// One page of a list in a stable order. <paramref name="TotalCount"/>, when given, counts every item the filter matches —
/// not only this page — so the interface can say how many there are and how many are still to load (DEV-12).
/// </summary>
public sealed record PagedResult<T>(IReadOnlyList<T> Items, string? NextCursor, int? TotalCount = null);

/// <summary>
/// Opaque keyset cursor: (sort key, then, id) serialized as base64url JSON. <paramref name="Then"/> is the second sort key of
/// lists ordered by two columns (an invoice's date, then its number); the id breaks every remaining tie, so equal dates and
/// numbers never repeat or skip a row. Cursors written before <paramref name="Then"/> existed read with it empty.
/// </summary>
public sealed record KeysetCursor(string SortKey, Guid Id, string? Then = null)
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 200;

    public string Encode() => Base64Url.EncodeToString(JsonSerializer.SerializeToUtf8Bytes(this));

    public static KeysetCursor? Decode(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<KeysetCursor>(Base64Url.DecodeFromChars(cursor));
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }
    }

    public static int ClampLimit(int? limit) => Math.Clamp(limit ?? DefaultLimit, 1, MaxLimit);
}
