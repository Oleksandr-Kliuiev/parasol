using System.Buffers.Text;
using System.Text.Json;

namespace Crm.SharedKernel.Application;

public sealed record PagedResult<T>(IReadOnlyList<T> Items, string? NextCursor);

/// <summary>Opaque keyset cursor: (sort key, id) serialized as base64url JSON.</summary>
public sealed record KeysetCursor(string SortKey, Guid Id)
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
