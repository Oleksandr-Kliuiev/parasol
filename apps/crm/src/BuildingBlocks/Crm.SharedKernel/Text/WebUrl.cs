namespace Crm.SharedKernel.Text;

/// <summary>
/// An address that is stored and later rendered as a link or printed in an export must be an absolute http or https URL:
/// "javascript:", "data:" and the like are refused where a person types them and dropped where a sync or an import brings
/// them (ASVS V1.2, F-G1-05).
/// </summary>
public static class WebUrl
{
    /// <summary>True when <paramref name="value"/> is an absolute http(s) URL with a host and no control character.</summary>
    public static bool IsHttp(string? value) => TryParse(value, out _);

    /// <summary>
    /// Adds "https://" to a bare host ("havbris.no" → "https://havbris.no") and returns the address when the result is a
    /// safe http(s) URL; null for anything else.
    /// </summary>
    public static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var text = value.Trim();
        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = "https://" + text;
        }

        return TryParse(text, out _) ? text : null;
    }

    /// <summary>
    /// An address the application calls out to (a provider's API, a token endpoint, a webhook): absolute and https, with
    /// http allowed only for a loopback host (a local stub in development and tests). Checked at startup so a mistyped
    /// setting cannot send credentials in clear text (F-G4-16).
    /// </summary>
    public static bool IsSecureEndpoint(Uri? url) =>
        url is { IsAbsoluteUri: true } && string.IsNullOrEmpty(url.UserInfo)
        && (url.Scheme == Uri.UriSchemeHttps || (url.Scheme == Uri.UriSchemeHttp && url.IsLoopback));

    /// <summary>True when the host is one of <paramref name="suffixes"/> or a subdomain of it ("a.logic.azure.com" fits "logic.azure.com").</summary>
    public static bool HostMatches(Uri url, IEnumerable<string> suffixes) =>
        suffixes.Any(suffix =>
        {
            var s = suffix.Trim().TrimStart('.');
            return s.Length > 0 && (url.Host.Equals(s, StringComparison.OrdinalIgnoreCase) || url.Host.EndsWith("." + s, StringComparison.OrdinalIgnoreCase));
        });

    private static bool TryParse(string? value, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(value) || value.Any(char.IsControl))
        {
            return false;
        }

        return Uri.TryCreate(value.Trim(), UriKind.Absolute, out uri) && uri.Scheme is "http" or "https" && !string.IsNullOrEmpty(uri.Host);
    }
}
