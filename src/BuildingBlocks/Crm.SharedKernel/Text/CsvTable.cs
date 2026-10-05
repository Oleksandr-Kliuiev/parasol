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
    /// <summary>A row has more cells than the header and the extra ones hold something: the columns are probably shifted.</summary>
    public const string RaggedExtra = "RAGGED_ROW_EXTRA";

    /// <summary>A row has fewer cells than the header.</summary>
    public const string RaggedShort = "RAGGED_ROW_SHORT";

    /// <summary>A quoted value was never closed: the rest of the file was read into it.</summary>
    public const string UnterminatedQuote = "UNTERMINATED_QUOTE";

    private readonly Dictionary<string, int> _columns;
    private readonly List<List<string>> _rows;
    private readonly List<int> _lines;
    private readonly Dictionary<int, List<string>> _rowIssues;

    private CsvTable(
        Dictionary<string, int> columns, List<List<string>> rows, List<int> lines, IReadOnlyList<string> unknownColumns,
        Dictionary<int, List<string>> rowIssues)
    {
        _columns = columns;
        _rows = rows;
        _lines = lines;
        UnknownColumns = unknownColumns;
        _rowIssues = rowIssues;
        Issues = rowIssues.SelectMany(i => i.Value.Select(code => new CsvIssue(lines[i.Key], code))).OrderBy(i => i.Line).ToList();
    }

    public IReadOnlyList<string> UnknownColumns { get; }

    /// <summary>Structural problems found while reading (ragged rows, an unterminated quote), by the line the row starts on.</summary>
    public IReadOnlyList<CsvIssue> Issues { get; }

    /// <summary>Data rows, not counting the header or blank lines.</summary>
    public int RowCount => _rows.Count;

    /// <summary>
    /// The line of the file the row starts on, as an editor shows it: the header is usually line 1, blank lines count and a
    /// quoted value that spans several lines moves the next row down by that many.
    /// </summary>
    public int Line(int row) => _lines[row];

    /// <summary>Structural problem codes of one row (see <see cref="RaggedExtra"/>, <see cref="RaggedShort"/>, <see cref="UnterminatedQuote"/>).</summary>
    public IReadOnlyList<string> RowIssues(int row) => _rowIssues.TryGetValue(row, out var issues) ? issues : [];

    public bool Has(string column) => _columns.ContainsKey(column);

    public string? Value(int row, string column) =>
        _columns.TryGetValue(column, out var index) && index < _rows[row].Count ? Clean(_rows[row][index]) : null;

    /// <summary>
    /// Parses the file with the given header aliases; returns null when the file has no usable header. Records are split the
    /// way RFC 4180 does it: a value that starts with a quote may hold the delimiter, line breaks and doubled quotes, and a
    /// quote in the middle of an unquoted value is just a character. A leading BOM is ignored.
    /// </summary>
    public static CsvTable? Parse(string content, IReadOnlyDictionary<string, string> aliases)
    {
        var text = (content ?? string.Empty).TrimStart('\uFEFF');
        var delimiter = DetectDelimiter(text);
        var records = Read(text, delimiter);
        if (records.Count < 2)
        {
            return null;
        }

        var header = records[0].Cells;
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

        var rows = new List<List<string>>(records.Count - 1);
        var lines = new List<int>(records.Count - 1);
        var issues = new Dictionary<int, List<string>>();
        for (var r = 1; r < records.Count; r++)
        {
            var cells = records[r].Cells;
            var row = rows.Count;
            rows.Add(cells);
            lines.Add(records[r].Line);
            var found = new List<string>();
            if (cells.Count < header.Count)
            {
                found.Add(RaggedShort);
            }
            else if (cells.Skip(header.Count).Any(c => !string.IsNullOrWhiteSpace(c)))
            {
                found.Add(RaggedExtra);
            }

            if (records[r].Unterminated)
            {
                found.Add(UnterminatedQuote);
            }

            if (found.Count > 0)
            {
                issues[row] = found;
            }
        }

        return new CsvTable(columns, rows, lines, unknown, issues);
    }

    /// <summary>Header text without case, spaces, underscores or a BOM, which is what the alias table is keyed by.</summary>
    public static string Normalize(string value) =>
        new(value.Trim().Trim('"', '﻿').Where(c => !char.IsWhiteSpace(c) && c != '_' && c != '-').Select(char.ToLowerInvariant).ToArray());

    /// <summary>A value without surrounding white space. The reader has already removed the quotes that wrapped it; quotes that belong to the text stay.</summary>
    public static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

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

    /// <summary>
    /// A date as the supplier wrote it. <c>yyyy-MM-dd</c> (also at the start of an ISO date-time, read as written without a
    /// time zone conversion) and the Norwegian <c>dd.MM.yyyy</c> are always read day first. A slash date such as 03/04/2026
    /// is day first in Norway and month first in the US: when both readings are valid and differ, the value is not guessed —
    /// the result is null and <paramref name="ambiguous"/> is set; with a day above 12 only one reading exists and it is used.
    /// </summary>
    public static DateOnly? Date(string? value, out bool ambiguous)
    {
        ambiguous = false;
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var text = value.Trim();
        var culture = CultureInfo.InvariantCulture;
        if (text.Length >= 10 && (text.Length == 10 || text[10] is 'T' or ' ') &&
            DateOnly.TryParseExact(text[..10], "yyyy-MM-dd", culture, DateTimeStyles.None, out var iso))
        {
            return iso;
        }

        if (DateOnly.TryParseExact(text, ["dd.MM.yyyy", "d.M.yyyy"], culture, DateTimeStyles.None, out var dotted))
        {
            return dotted;
        }

        var dayFirst = DateOnly.TryParseExact(text, ["dd/MM/yyyy", "d/M/yyyy"], culture, DateTimeStyles.None, out var norwegian);
        var monthFirst = DateOnly.TryParseExact(text, ["MM/dd/yyyy", "M/d/yyyy"], culture, DateTimeStyles.None, out var american);
        if (dayFirst && monthFirst && norwegian != american)
        {
            ambiguous = true;
            return null;
        }

        return dayFirst ? norwegian : monthFirst ? american : null;
    }

    public static DateOnly? Date(string? value) => Date(value, out _);

    private static char DetectDelimiter(string text)
    {
        int semicolons = 0, commas = 0;
        var inQuotes = false;
        var seenContent = false;
        foreach (var c in text)
        {
            if (c == '"')
            {
                inQuotes = !inQuotes;
                seenContent = true;
            }
            else if (!inQuotes && c is '\n' or '\r')
            {
                if (seenContent)
                {
                    break;
                }
            }
            else if (!inQuotes && c == ';')
            {
                semicolons++;
                seenContent = true;
            }
            else if (!inQuotes && c == ',')
            {
                commas++;
                seenContent = true;
            }
            else if (!char.IsWhiteSpace(c))
            {
                seenContent = true;
            }
        }

        return semicolons >= commas ? ';' : ',';
    }

    private sealed record Record(List<string> Cells, int Line, bool Unterminated);

    private static List<Record> Read(string text, char delimiter)
    {
        var records = new List<Record>();
        var cells = new List<string>();
        var value = new StringBuilder();
        var inQuotes = false;
        var quoted = false;
        var line = 1;
        var recordLine = 1;
        var recordStarted = false;

        void EndCell()
        {
            cells.Add(value.ToString());
            value.Clear();
            quoted = false;
        }

        void EndRecord(bool unterminated)
        {
            EndCell();
            // A line that holds nothing but white space is not a record; its line number still counts.
            if (!(cells.Count == 1 && string.IsNullOrWhiteSpace(cells[0]) && !recordStarted))
            {
                records.Add(new Record(cells, recordLine, unterminated));
            }

            cells = [];
            recordStarted = false;
        }

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        value.Append('"');
                        i++;
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
                    {
                        continue;
                    }

                    if (c is '\n' or '\r')
                    {
                        line++;
                        value.Append('\n');
                    }
                    else
                    {
                        value.Append(c);
                    }
                }

                continue;
            }

            if (c is '\r' or '\n')
            {
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n')
                {
                    i++;
                }

                EndRecord(unterminated: false);
                line++;
                recordLine = line;
                continue;
            }

            if (!recordStarted && !char.IsWhiteSpace(c))
            {
                recordStarted = true;
                recordLine = line;
            }

            if (c == '"' && !quoted && value.ToString().Trim().Length == 0)
            {
                // A value that starts with a quote is quoted; white space before the quote is not part of it.
                value.Clear();
                inQuotes = true;
                quoted = true;
                recordStarted = true;
            }
            else if (c == delimiter)
            {
                recordStarted = true;
                EndCell();
            }
            else
            {
                value.Append(c);
            }
        }

        if (inQuotes || recordStarted || value.Length > 0 || cells.Count > 0)
        {
            EndRecord(unterminated: inQuotes);
        }

        return records;
    }
}

/// <summary>A structural problem in a file: which line a row starts on and a machine-readable code.</summary>
public sealed record CsvIssue(int Line, string Code);
