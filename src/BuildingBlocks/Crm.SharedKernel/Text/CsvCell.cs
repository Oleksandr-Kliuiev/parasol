namespace Crm.SharedKernel.Text;

/// <summary>
/// Writes one text value into a delimiter-separated export so that a spreadsheet shows it as text and a parser reads one
/// field (OWASP "CSV injection", ASVS V1.2.10): a value that would start a formula is prefixed with an apostrophe, and a value
/// with the delimiter, a quote or a line break is quoted.
/// </summary>
public static class CsvCell
{
    /// <summary>True when a spreadsheet would read the text as a formula or a command: it starts with = + - @, a tab or a CR.</summary>
    public static bool LooksLikeFormula(string text) => text.Length > 0 && text[0] is '=' or '+' or '-' or '@' or '\t' or '\r';

    /// <summary>The text neutralized for a spreadsheet: a leading apostrophe makes the cell text, it is not part of the value shown.</summary>
    public static string Neutralize(string text) => LooksLikeFormula(text) ? "'" + text : text;

    /// <summary>A field of a CSV record with the given delimiter: neutralized, and quoted when the parser would otherwise split it.</summary>
    public static string Write(string text, char delimiter = ';')
    {
        var safe = Neutralize(text);
        return safe.IndexOfAny([delimiter, ',', '"', '\r', '\n']) >= 0
            ? "\"" + safe.Replace("\"", "\"\"", StringComparison.Ordinal) + "\""
            : safe;
    }
}
