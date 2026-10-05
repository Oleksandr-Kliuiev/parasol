namespace Crm.Web.Auth;

/// <summary>
/// The only places sign-in may send the browser back to are paths of this application (ASVS 3.1.2 / redirect validation). A
/// value is accepted when it is a path with a single leading slash and, in every percent-decoded form of it, has no second
/// slash or backslash right after the first, no control characters and no non-ASCII character in that position: browsers drop
/// tabs and newlines inside URLs and treat <c>\</c> as <c>/</c>, so <c>/\t/evil.example</c> would otherwise become
/// <c>//evil.example</c>. Anything else becomes <c>/</c>.
/// </summary>
internal static class ReturnUrl
{
    private const int MaxLength = 2048;
    private const int MaxDecodings = 3;

    public static string Safe(string? value) => IsSafe(value) ? value! : "/";

    public static bool IsSafe(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxLength)
        {
            return false;
        }

        // The raw value and what a server, a proxy or a browser makes of it after decoding once, twice, three times.
        var form = value;
        for (var round = 0; round <= MaxDecodings; round++)
        {
            if (!IsSafeForm(form))
            {
                return false;
            }

            string decoded;
            try
            {
                decoded = Uri.UnescapeDataString(form);
            }
            catch (UriFormatException)
            {
                return false;
            }

            if (decoded == form)
            {
                break;
            }

            form = decoded;
        }

        return Uri.TryCreate(value, UriKind.Relative, out _);
    }

    private static bool IsSafeForm(string form)
    {
        if (form.Length == 0 || form[0] != '/')
        {
            return false;
        }

        // Control characters and DEL anywhere; a backslash anywhere (browsers read it as a slash).
        foreach (var c in form)
        {
            if (c < 0x20 || c == 0x7f || c == '\\')
            {
                return false;
            }
        }

        // What follows the first slash: not another slash, and nothing outside ASCII (full-width and other look-alikes).
        return form.Length == 1 || (form[1] != '/' && form[1] < 0x7f);
    }
}
