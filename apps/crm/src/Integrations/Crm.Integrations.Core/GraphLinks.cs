namespace Crm.Integrations.Core;

/// <summary>
/// An app-only Graph token is valid for the whole directory, so it goes only to the configured Graph address (F-G5-12). The
/// links a response names (<c>@odata.nextLink</c>, <c>@odata.deltaLink</c>, the operation and manifest of the Partner Center
/// billing export) and the stored delta cursor are data from outside the code: they are followed only when scheme, host and
/// port are those of that address.
/// </summary>
public static class GraphLinks
{
    public static bool IsSameOrigin(Uri? baseAddress, Uri? uri) =>
        baseAddress is not null && uri is { IsAbsoluteUri: true } && string.IsNullOrEmpty(uri.UserInfo)
        && Uri.Compare(uri, baseAddress, UriComponents.SchemeAndServer, UriFormat.Unescaped, StringComparison.OrdinalIgnoreCase) == 0;

    public static bool IsSameOrigin(Uri? baseAddress, string? link) =>
        Uri.TryCreate(link, UriKind.Absolute, out var uri) && IsSameOrigin(baseAddress, uri);

    /// <summary>The link unchanged, or an exception that names no part of it.</summary>
    public static string Require(Uri? baseAddress, string link) =>
        IsSameOrigin(baseAddress, link) ? link : throw new InvalidOperationException("Microsoft Graph named a link outside the configured Graph address; it was not followed.");
}
