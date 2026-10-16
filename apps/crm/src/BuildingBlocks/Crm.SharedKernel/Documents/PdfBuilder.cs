using System.Globalization;
using System.Text;

namespace Crm.SharedKernel.Documents;

public enum PdfFontStyle
{
    Regular,
    Bold,
}

/// <summary>A grey or colour value in the 0..1 range PDF uses.</summary>
public readonly record struct PdfColor(float Red, float Green, float Blue)
{
    public static PdfColor Black { get; } = new(0.1f, 0.1f, 0.1f);

    public static PdfColor Grey { get; } = new(0.42f, 0.42f, 0.45f);

    public static PdfColor Line { get; } = new(0.82f, 0.82f, 0.85f);

    public static PdfColor Band { get; } = new(0.95f, 0.95f, 0.97f);

    public static PdfColor Accent { get; } = new(0.06f, 0.29f, 0.53f);

    internal string Operator(bool fill) => string.Create(
        CultureInfo.InvariantCulture, $"{Red:0.###} {Green:0.###} {Blue:0.###} {(fill ? "rg" : "RG")}");
}

/// <summary>
/// Writes a small A4 document with the two core fonts every PDF reader has (Helvetica and Helvetica-Bold), so a generated
/// quote needs no font file, no native library and no licence. Coordinates are in points and measured from the top-left
/// corner; the writer flips them for the PDF coordinate system.
/// </summary>
public sealed class PdfBuilder
{
    public const float A4Width = 595.28f;
    public const float A4Height = 841.89f;

    private readonly List<StringBuilder> _pages = [];
    private readonly string _title;
    private StringBuilder _content = new();
    private Func<int, int, string>? _footer;

    public PdfBuilder(string title)
    {
        _title = title;
        _pages.Add(_content);
        Y = Margin;
    }

    public static float Margin => 56f;

    public static float Left => Margin;

    public static float Right => A4Width - Margin;

    public static float ContentWidth => Right - Left;

    /// <summary>Distance of the writing cursor from the top of the page.</summary>
    public float Y { get; set; }

    public int PageCount => _pages.Count;

    /// <summary>Text stamped at the bottom of every page once the document is finished; arguments are page number and count.</summary>
    public void SetFooter(Func<int, int, string> footer) => _footer = footer;

    public void NewPage()
    {
        _content = new StringBuilder();
        _pages.Add(_content);
        Y = Margin;
    }

    /// <summary>Starts a new page when the next block would run into the bottom margin.</summary>
    public bool EnsureSpace(float height)
    {
        if (Y + height <= A4Height - Margin - 24f)
        {
            return false;
        }

        NewPage();
        return true;
    }

    public void DrawText(string text, float x, float baseline, float size, PdfFontStyle style = PdfFontStyle.Regular, PdfColor? color = null)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        var font = style == PdfFontStyle.Bold ? "/F2" : "/F1";
        _content.Append(CultureInfo.InvariantCulture, $"BT {(color ?? PdfColor.Black).Operator(true)} {font} {size:0.##} Tf ");
        _content.Append(CultureInfo.InvariantCulture, $"1 0 0 1 {x:0.##} {A4Height - baseline:0.##} Tm ({Escape(text)}) Tj ET\n");
    }

    public void DrawTextRight(string text, float right, float baseline, float size, PdfFontStyle style = PdfFontStyle.Regular, PdfColor? color = null) =>
        DrawText(text, right - Measure(text, size, style), baseline, size, style, color);

    public void DrawRect(float x, float top, float width, float height, PdfColor fill)
    {
        _content.Append(CultureInfo.InvariantCulture, $"{fill.Operator(true)} {x:0.##} {A4Height - top - height:0.##} {width:0.##} {height:0.##} re f\n");
    }

    public void DrawRule(float top, float? from = null, float? to = null, float thickness = 0.6f, PdfColor? color = null) =>
        DrawRect(from ?? Left, top, (to ?? Right) - (from ?? Left), thickness, color ?? PdfColor.Line);

    /// <summary>Writes a block of text at the cursor, wrapping it to <paramref name="width"/>, and moves the cursor below it.</summary>
    public void Paragraph(string text, float size = 9.5f, PdfFontStyle style = PdfFontStyle.Regular, PdfColor? color = null, float? width = null, float lineHeight = 1.35f)
    {
        foreach (var line in Wrap(text, width ?? ContentWidth, size, style))
        {
            EnsureSpace(size * lineHeight);
            Y += size * lineHeight;
            DrawText(line, Left, Y, size, style, color);
        }
    }

    public void MoveDown(float points) => Y += points;

    /// <summary>
    /// Splits text into lines that fit, honouring the line breaks it already contains. A word wider than the line (a long
    /// code, address or link) is broken where it reaches the edge: text is never drawn past the width, and never cut off.
    /// </summary>
    public static IReadOnlyList<string> Wrap(string text, float width, float size, PdfFontStyle style = PdfFontStyle.Regular)
    {
        var lines = new List<string>();
        foreach (var paragraph in (text ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            var current = new StringBuilder();
            foreach (var word in paragraph.Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                var candidate = current.Length == 0 ? word : $"{current} {word}";
                if (Measure(candidate, size, style) <= width)
                {
                    current.Clear().Append(candidate);
                    continue;
                }

                if (current.Length > 0)
                {
                    lines.Add(current.ToString());
                    current.Clear();
                }

                var rest = word;
                while (rest.Length > 1 && Measure(rest, size, style) > width)
                {
                    var fit = rest.Length - 1;
                    while (fit > 1 && Measure(rest[..fit], size, style) > width)
                    {
                        fit--;
                    }

                    lines.Add(rest[..fit]);
                    rest = rest[fit..];
                }

                current.Append(rest);
            }

            lines.Add(current.ToString());
        }

        return lines;
    }

    /// <summary>Shortens text with an ellipsis so it fits the width — for table cells that may not wrap.</summary>
    public static string Ellipsize(string text, float width, float size, PdfFontStyle style = PdfFontStyle.Regular)
    {
        if (Measure(text, size, style) <= width)
        {
            return text;
        }

        var cut = text;
        while (cut.Length > 1 && Measure($"{cut}…", size, style) > width)
        {
            cut = cut[..^1];
        }

        return $"{cut.TrimEnd()}…";
    }

    /// <summary>Width of the text in points. Digits and punctuation are exact, so amounts line up in their column.</summary>
    public static float Measure(string text, float size, PdfFontStyle style = PdfFontStyle.Regular)
    {
        var widths = style == PdfFontStyle.Bold ? BoldWidths : RegularWidths;
        var total = 0;
        foreach (var character in text ?? string.Empty)
        {
            // Measured as written: the characters WinAnsi lacks are replaced on the way out (see Escape).
            total += character switch
            {
                '…' => 3 * widths['.'],
                '–' or '—' => widths['-'],
                '‘' or '’' => widths['\''],
                '“' or '”' => widths['"'],
                '\u00A0' => widths[' '],
                _ => character < widths.Length ? widths[character] : 556,
            };
        }

        return total * size / 1000f;
    }

    public byte[] Build()
    {
        if (_footer is { } footer)
        {
            for (var index = 0; index < _pages.Count; index++)
            {
                _content = _pages[index];
                DrawRule(A4Height - Margin + 8f, color: PdfColor.Line);
                DrawText(footer(index + 1, _pages.Count), Left, A4Height - Margin + 22f, 8f, PdfFontStyle.Regular, PdfColor.Grey);
            }
        }

        // Object 1 catalog, 2 page tree, 3 and 4 fonts, 5 document information, then a page and a content stream per page.
        var objects = new List<string>();
        var pageIds = Enumerable.Range(0, _pages.Count).Select(i => 6 + (i * 2)).ToList();
        objects.Add("<< /Type /Catalog /Pages 2 0 R >>");
        objects.Add($"<< /Type /Pages /Count {_pages.Count} /Kids [{string.Join(' ', pageIds.Select(id => $"{id} 0 R"))}] >>");
        objects.Add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
        objects.Add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
        objects.Add($"<< /Title ({Escape(_title)}) /Producer (Vardahei CRM) >>");
        for (var index = 0; index < _pages.Count; index++)
        {
            var content = _pages[index].ToString();
            objects.Add(string.Create(
                CultureInfo.InvariantCulture,
                $"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {A4Width:0.##} {A4Height:0.##}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {pageIds[index] + 1} 0 R >>"));
            objects.Add($"<< /Length {Encoding.Latin1.GetByteCount(content)} >>\nstream\n{content}endstream");
        }

        using var stream = new MemoryStream();
        Write(stream, "%PDF-1.7\n%åäöü\n");
        var offsets = new List<long>();
        for (var index = 0; index < objects.Count; index++)
        {
            offsets.Add(stream.Position);
            Write(stream, $"{index + 1} 0 obj\n{objects[index]}\nendobj\n");
        }

        var xref = stream.Position;
        Write(stream, $"xref\n0 {objects.Count + 1}\n0000000000 65535 f \n");
        foreach (var offset in offsets)
        {
            Write(stream, string.Create(CultureInfo.InvariantCulture, $"{offset:0000000000} 00000 n \n"));
        }

        Write(stream, string.Create(CultureInfo.InvariantCulture, $"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n"));
        return stream.ToArray();
    }

    private static void Write(Stream stream, string text)
    {
        var bytes = Encoding.Latin1.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
    }

    /// <summary>WinAnsi covers Norwegian; anything outside it (Cyrillic, emoji) would be unreadable and becomes a question mark.</summary>
    private static string Escape(string text)
    {
        var builder = new StringBuilder(text.Length + 8);
        foreach (var character in text)
        {
            switch (character)
            {
                case '(' or ')' or '\\':
                    builder.Append('\\').Append(character);
                    break;
                case '\n' or '\r' or '\t':
                    builder.Append(' ');
                    break;
                case '–' or '—':
                    builder.Append('-');
                    break;
                case '‘' or '’':
                    builder.Append('\'');
                    break;
                case '“' or '”':
                    builder.Append('"');
                    break;
                case '…':
                    builder.Append("...");
                    break;
                case ' ':
                    builder.Append(' ');
                    break;
                default:
                    builder.Append(character <= 'ÿ' ? character : '?');
                    break;
            }
        }

        return builder.ToString();
    }

    private static readonly int[] RegularWidths = BuildWidths(
        "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 " +
        "1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 " +
        "333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584",
        aring: 556, ae: 889, oslash: 611, aringCapital: 667, aeCapital: 1000, oslashCapital: 778);

    private static readonly int[] BoldWidths = BuildWidths(
        "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 " +
        "975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 " +
        "333 556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584",
        aring: 556, ae: 889, oslash: 611, aringCapital: 722, aeCapital: 1000, oslashCapital: 778);

    /// <summary>Helvetica advance widths (1000 per em) for space..~ plus the Norwegian letters; everything else falls back to 556.</summary>
    private static int[] BuildWidths(string ascii, int aring, int ae, int oslash, int aringCapital, int aeCapital, int oslashCapital)
    {
        var widths = new int[256];
        Array.Fill(widths, 556);
        var values = ascii.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(v => int.Parse(v, CultureInfo.InvariantCulture)).ToArray();
        for (var index = 0; index < values.Length; index++)
        {
            widths[' ' + index] = values[index];
        }

        widths['å'] = aring;
        widths['ä'] = aring;
        widths['æ'] = ae;
        widths['ø'] = oslash;
        widths['ö'] = oslash;
        widths['Å'] = aringCapital;
        widths['Ä'] = aringCapital;
        widths['Æ'] = aeCapital;
        widths['Ø'] = oslashCapital;
        widths['Ö'] = oslashCapital;
        return widths;
    }
}
