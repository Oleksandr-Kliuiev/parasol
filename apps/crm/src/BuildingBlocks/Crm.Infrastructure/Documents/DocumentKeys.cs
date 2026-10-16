namespace Crm.Infrastructure.Documents;

public static class DocumentKeys
{
    /// <summary>Canonical relative paths; empty and dot segments would give one object multiple identities.</summary>
    public static void Guard(string key)
    {
        if (string.IsNullOrEmpty(key) || key.Length > 512 || key.Contains("..", StringComparison.Ordinal) ||
            key.Split('/').Any(segment => segment.Length is 0 or > 255 || segment == "." || segment == ".parasol-volume" ||
                segment.StartsWith(".stage-", StringComparison.Ordinal) || segment.StartsWith(".probe-", StringComparison.Ordinal)) ||
            !key.All(c => char.IsAsciiLetterOrDigit(c) || c is '/' or '-' or '_' or '.'))
        {
            throw new ArgumentException("Invalid document key.", nameof(key));
        }
    }
}
