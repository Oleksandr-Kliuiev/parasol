using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;

namespace Crm.Integrations.Core.Webhooks;

/// <summary>
/// The signature of a webhook sent through Svix (Huntress's, M44), as Svix documents it for checking without its library: HMAC-SHA256
/// over <c>{id}.{timestamp}.{body}</c> with the endpoint's secret (<c>whsec_</c> and the key in Base64), sent in Base64 as one or
/// more space-separated <c>v1,{signature}</c> (two while the vendor rotates its secret). The body is checked exactly as it arrived,
/// and a delivery signed more than five minutes from now is refused, so a recorded one cannot be replayed later. The headers are
/// Svix's own (<c>svix-id</c> …) or the Standard Webhooks names Svix also sends (<c>webhook-id</c> …).
/// </summary>
public static class SvixSignature
{
    public static readonly TimeSpan Tolerance = TimeSpan.FromMinutes(5);

    private const string SecretPrefix = "whsec_";
    private const string Version = "v1";

    /// <summary>The key of a <c>whsec_</c> secret, or null when the value is not one (the source then stays off).</summary>
    public static byte[]? Key(string? secret)
    {
        var value = secret?.Trim();
        if (value is null || !value.StartsWith(SecretPrefix, StringComparison.Ordinal))
        {
            return null;
        }

        var encoded = value[SecretPrefix.Length..];
        var key = new byte[encoded.Length];
        return Convert.TryFromBase64String(encoded, key, out var written) && written >= 16 ? key[..written] : null;
    }

    /// <summary>Null when the delivery is signed with <paramref name="key"/> within the tolerance; otherwise why it is not.</summary>
    public static WebhookRefusal? Verify(byte[] key, IHeaderDictionary headers, ReadOnlySpan<byte> body, DateTimeOffset now)
    {
        var id = Header(headers, "svix-id", "webhook-id");
        var timestamp = Header(headers, "svix-timestamp", "webhook-timestamp");
        var signatures = Header(headers, "svix-signature", "webhook-signature");
        if (id is null || timestamp is null || signatures is null)
        {
            return WebhookRefusal.Unsigned;
        }

        if (!long.TryParse(timestamp, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds) ||
            Math.Abs(now.ToUnixTimeSeconds() - seconds) > (long)Tolerance.TotalSeconds)
        {
            return WebhookRefusal.Stale;
        }

        Span<byte> expected = stackalloc byte[HMACSHA256.HashSizeInBytes];
        using (var hmac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, key))
        {
            hmac.AppendData(Encoding.UTF8.GetBytes($"{id}.{timestamp}."));
            hmac.AppendData(body);
            hmac.GetHashAndReset(expected);
        }

        Span<byte> given = stackalloc byte[HMACSHA256.HashSizeInBytes];
        foreach (var part in signatures.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var comma = part.IndexOf(',', StringComparison.Ordinal);
            if (comma > 0 && part.AsSpan(0, comma).SequenceEqual(Version) &&
                Convert.TryFromBase64String(part[(comma + 1)..], given, out var written) && written == given.Length &&
                CryptographicOperations.FixedTimeEquals(given, expected))
            {
                return null;
            }
        }

        return WebhookRefusal.BadSignature;
    }

    /// <summary>The signature header Svix would send, for the tests that sign their deliveries the same way.</summary>
    internal static string Sign(byte[] key, string id, long timestamp, ReadOnlySpan<byte> body)
    {
        using var hmac = IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, key);
        hmac.AppendData(Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"{id}.{timestamp}.")));
        hmac.AppendData(body);
        return $"{Version},{Convert.ToBase64String(hmac.GetHashAndReset())}";
    }

    private static string? Header(IHeaderDictionary headers, string name, string standardName) =>
        headers.TryGetValue(name, out var value) && value.Count == 1 && !string.IsNullOrWhiteSpace(value[0]) ? value[0]
        : headers.TryGetValue(standardName, out var standard) && standard.Count == 1 && !string.IsNullOrWhiteSpace(standard[0]) ? standard[0]
        : null;
}
