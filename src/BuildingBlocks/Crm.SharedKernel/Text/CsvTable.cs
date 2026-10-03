using System.Globalization;
using System.Text;

namespace Crm.SharedKernel.Text;

/// <summary>
/// A small reader for the files partners and distributors send: semicolon or comma separated, quoted values, header names
/// matched loosely (case, spaces, underscores and the Norwegian spellings). Unknown columns are reported, not rejected,
/// because every supplier adds their own.
/// </summary>
public sealed class CsvTable
{
    private readonly Dictionary<string, int> _columns;
    private readonly List<List<string>> _rows;

    private CsvTable(Dictionary<string, int> columns, List<List<string>> rows, IReadOnlyList<string> unknownColumns)
    {
        _columns = columns;
        _rows = rows;
        UnknownColumns = unknownColumns;
    }

    public IReadOnlyList<string> UnknownColumns { get; }

    public int RowCount => _rows.Count;

    /// <summary>Row numbers as a person sees them in a spreadsheet: the header is row 1.</summary>
    public static int LineNumber(int row) => row + 2;

    public bool Has(string column) => _columns.ContainsKey(column);

    public string? Value(int row, string column) =>
        _columns.TryGetValue(column, out var index) && index < _rows[row].Count ? Clean(_rows[row][index]) : null;

    /// <summary>Parses the file with the given header aliases; returns null when the file has no usable header.</summary>
    public static CsvTable? Parse(string content, IReadOnlyDictionary<string, string> aliases)
    {
        var lines = (content ?? string.Empty)
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Split('\n')
            .Where(line => line.Trim().Length > 0)
            .ToArray();
        if (lines.Length < 2)
        {
            return null;
        }

        var delimiter = lines[0].Count(c => c == ';') >= lines[0].Count(c => c == ',') ? ';' : ',';
        var header = Split(lines[0], delimiter);
        var columns = new Dictionary<string, int>(StringComparer.Ordinal);
        var unknown = new List<string>();
        for (var i = 0; i < header.Count; i++)
        {
            var name = Normalize(header[i]);
            if (name.Length == 0)
            {
                continue;
            }

            if (aliases.TryGetValue(name, out var column))
            {
                columns.TryAdd(column, i);
            }
            else
            {
                unknown.Add(Clean(header[i]) ?? name);
            }
        }

        var rows = new List<List<string>>(lines.Length - 1);
        for (var row = 1; row < lines.Length; row++)
        {
            rows.Add(Split(lines[row], delimiter));
        }

        return new CsvTable(columns, rows, unknown);
    }

    /// <summary>Header text without case, spaces, underscores or a BOM, which is what the alias table is keyed by.</summary>
    public static string Normalize(string value) =>
        new(value.Trim().Trim('"', '﻿').Where(c => !char.IsWhiteSpace(c) && c != '_' && c != '-').Select(char.ToLowerInvariant).ToArray());

    public static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().Trim('"').Trim();

    /// <summary>Accepts both the Norwegian comma and the English point, and spaces as thousand separators.</summary>
    public static decimal? Decimal(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var normalized = value
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .Replace(",", ".", StringComparison.Ordinal);
        return decimal.TryParse(normalized, NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    public static int? Int(string? value) => Decimal(value) is { } number ? (int)decimal.Round(number) : null;

    public static DateOnly? Date(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string[] formats = ["yyyy-MM-dd", "dd.MM.yyyy", "dd/MM/yyyy", "MM/dd/yyyy"];
        if (DateOnly.TryParseExact(value[..Math.Min(10, value.Length)], formats, CultureInfo.InvariantCulture, DateTimeStyles.None, out var exact))
        {
            return exact;
        }

        return DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var parsed)
            ? DateOnly.FromDateTime(parsed.UtcDateTime)
            : null;
    }

    private static List<string> Split(string line, char delimiter)
    {
        var values = new List<string>();
        var current = new StringBuilder();
        var inQuotes = false;
        foreach (var c in line)
        {
            if (c == '"')
            {
                inQuotes = !inQuotes;
            }
            else if (c == delimiter && !inQuotes)
            {
                values.Add(current.ToString());
                current.Clear();
            }
            else
            {
                current.Append(c);
            }
        }

        values.Add(current.ToString());
        return values;
    }
}
