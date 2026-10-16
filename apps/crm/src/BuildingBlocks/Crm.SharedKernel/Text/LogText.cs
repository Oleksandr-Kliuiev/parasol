namespace Crm.SharedKernel.Text;

/// <summary>
/// Free text from a person that is written to a log line as a structured parameter. The console formatter prints it as is, so a
/// line break inside it would start what looks like another log entry (log forging, ASVS V16.4.1, F-G5-10).
/// </summary>
public static class LogText
{
    /// <summary>Control characters and the Unicode line and paragraph separators become one space each.</summary>
    public static string? Clean(string? value)
    {
        if (value is null || !value.Any(IsUnsafe))
        {
            return value;
        }

        return new string(value.Select(c => IsUnsafe(c) ? ' ' : c).ToArray());
    }

    private static bool IsUnsafe(char c) => char.IsControl(c) || c == 0x2028 || c == 0x2029;
}
