using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Crm.Sales.Features;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>
/// The stored quote document, page by page (DEV-08-AC06): a long quote in Norwegian and English runs over several pages and
/// every line of text stays inside the margins, the footer numbers every page, the totals come once at the end, and the same
/// snapshot always gives the same bytes. With QUOTE_PDF_SAMPLES set the documents are also written there for a visual check.
/// </summary>
public partial class QuoteDocumentLayoutTests
{
    private const float Tolerance = 0.6f;

    public static TheoryData<string> Languages => new("nb", "en");

    [Theory]
    [MemberData(nameof(Languages))]
    public void A_long_quote_runs_over_pages_with_every_line_inside_the_margins(string language)
    {
        var snapshot = LongQuote(language);
        var bytes = QuotePdf.Render(snapshot);
        Save($"quote-long-{language}.pdf", bytes);
        var pages = Pages(bytes);

        pages.Count.ShouldBeGreaterThanOrEqualTo(3);
        var pageLabel = language == "en" ? "Page {0} of {1}" : "Side {0} av {1}";
        for (var index = 0; index < pages.Count; index++)
        {
            var footer = pages[index].Single(t => t.Baseline > PdfBuilder.A4Height - PdfBuilder.Margin);
            footer.Text.ShouldEndWith(string.Format(CultureInfo.InvariantCulture, pageLabel, index + 1, pages.Count));
            footer.Text.ShouldContain("Vardahei AS");
        }

        foreach (var text in pages.SelectMany(p => p))
        {
            text.X.ShouldBeGreaterThanOrEqualTo(PdfBuilder.Left - Tolerance, text.Text);
            (text.X + text.Width).ShouldBeLessThanOrEqualTo(PdfBuilder.Right + Tolerance, text.Text);
            text.Baseline.ShouldBeGreaterThan(PdfBuilder.Margin - Tolerance, text.Text);
            if (text.Baseline <= PdfBuilder.A4Height - PdfBuilder.Margin)
            {
                // Body text ends above the footer rule.
                text.Baseline.ShouldBeLessThanOrEqualTo(PdfBuilder.A4Height - PdfBuilder.Margin - 24f + Tolerance, text.Text);
            }
        }

        // The totals come once, together in one box, after the last line.
        var totalInclVat = language == "en" ? "Total incl. VAT" : "Sum inkl. mva.";
        var withTotals = pages.Select((page, index) => (Index: index, Count: page.Count(t => t.Text.Contains(totalInclVat)))).Where(p => p.Count > 0).ToList();
        withTotals.ShouldHaveSingleItem().Count.ShouldBe(2, "monthly and one-time totals, once each");
        withTotals[0].Index.ShouldBeGreaterThanOrEqualTo(pages.FindIndex(p => p.Any(t => t.Text.Contains(snapshot.Lines[^1].Name))));
        pages[0].ShouldContain(t => t.Text.Contains("T-2026-0042"));
        // A page the line table continues onto repeats the quote, the section and the column labels.
        var continued = language == "en" ? "(CONT.)" : "(FORTS.)";
        var quantity = language == "en" ? "Quantity" : "Antall";
        foreach (var page in pages.Skip(1).Where(p => p.Any(t => t.Text.Contains(continued))))
        {
            page.ShouldContain(t => t.Text.StartsWith(language == "en" ? "Quote T-2026-0042 · v2" : "Tilbud T-2026-0042 · v2", StringComparison.Ordinal));
            page.ShouldContain(t => t.Text == quantity);
        }

        pages.Skip(1).Count(p => p.Any(t => t.Text.Contains(continued))).ShouldBeGreaterThanOrEqualTo(2);
        pages[0].ShouldContain(t => t.Text == "Fjellbekk Løsninger og Ærlige Bygg AS");
        pages.SelectMany(p => p).Count(t => t.Text.Contains(snapshot.Lines[^1].Name)).ShouldBe(1);
        // Norwegian letters reach the paper as WinAnsi bytes, in both languages (customer and line texts).
        Encoding.Latin1.GetString(bytes).ShouldContain("Overvåking av brannmur");
    }

    [Fact]
    public void The_same_snapshot_always_gives_the_same_bytes_also_after_storing_it_as_json()
    {
        var snapshot = LongQuote("nb");
        var first = QuotePdf.Render(snapshot);
        var again = QuotePdf.Render(QuoteSnapshot.FromJson(snapshot.ToJson()));

        again.ShouldBe(first);
        DocumentHashes.Sha256(again).ShouldBe(DocumentHashes.Sha256(first));
        QuoteSnapshot.FromJson(snapshot.ToJson()).ToJson().ShouldBe(snapshot.ToJson());
    }

    [Fact]
    public void A_reconstructed_document_says_so_on_the_first_page_and_in_every_footer()
    {
        var snapshot = LongQuote("nb") with { ReconstructedOn = new DateOnly(2026, 10, 5) };
        var bytes = QuotePdf.Render(snapshot);
        Save("quote-reconstructed-nb.pdf", bytes);
        var pages = Pages(bytes);

        pages[0].ShouldContain(t => t.Text.StartsWith("Gjenskapt kopi, laget 05.10.2026", StringComparison.Ordinal));
        for (var index = 0; index < pages.Count; index++)
        {
            // The label leads the footer and the page numbers still fit: the template's footer text gives way.
            var footer = pages[index].Single(t => t.Baseline > PdfBuilder.A4Height - PdfBuilder.Margin);
            footer.Text.ShouldStartWith("Gjenskapt kopi 05.10.2026");
            footer.Text.ShouldEndWith($"Side {index + 1} av {pages.Count}");
            footer.Text.ShouldContain("...");
        }

        pages.SelectMany(p => p).ShouldAllBe(t => t.X + t.Width <= PdfBuilder.Right + Tolerance);
        QuotePdf.Render(LongQuote("nb")).ShouldNotBe(bytes);
    }

    [Theory]
    [MemberData(nameof(Languages))]
    public void Fields_at_their_longest_are_printed_whole_inside_their_columns(string language)
    {
        // As long as the database lets each field be; the e-mail address and the link in the description are single words.
        var lineName = Words("Microsoft 365 E5 med Teams Phone, Defender for Endpoint og Purview for", 256);
        var link = $"https://www.example.no/avtaler/{new string('a', 180)}/vilkar.pdf";
        var longest = LongQuote(language) with
        {
            Title = Words("Drift, forvaltning og sikkerhet for hele konsernet", 256),
            CustomerReference = $"PO-{new string('7', 125)}",
            OwnerName = Words("Kari Nordmann-Åsheim", 256),
            OwnerEmail = $"{new string('k', 240)}@example.no",
            Customer = new QuoteSnapshotCustomer(
                Words("Fjellbekk Løsninger og Ærlige Bygg AS avdeling", 256), "998 877 665", Words("Storgata 1 inngang B", 256), "5003", "Bergen",
                Words("Ola Åsheim", 257), $"{new string('o', 243)}@example.no"),
            Lines = [new QuoteSnapshotLine(lineName, $"Se {link} for vilkårene.", "SKU-1", 1, 100m, 0m, 100m, true), .. LongQuote(language).Lines.Skip(1)],
        };

        var bytes = QuotePdf.Render(longest);
        Save($"quote-longest-fields-{language}.pdf", bytes);
        var pages = Pages(bytes);
        var texts = pages.SelectMany(p => p).ToList();

        foreach (var text in texts)
        {
            text.X.ShouldBeGreaterThanOrEqualTo(PdfBuilder.Left - Tolerance, text.Text);
            (text.X + text.Width).ShouldBeLessThanOrEqualTo(PdfBuilder.Right + Tolerance, text.Text);
        }

        // Nothing written on one line runs into its neighbour: customer and meta columns, label and value, name and quantity.
        foreach (var page in pages)
        {
            foreach (var (first, second) in page.SelectMany((a, i) => page.Skip(i + 1).Select(b => (a, b))))
            {
                if (Math.Abs(first.Baseline - second.Baseline) < 7f)
                {
                    var apart = first.X + first.Width <= second.X + Tolerance || second.X + second.Width <= first.X + Tolerance;
                    apart.ShouldBeTrue($"'{first.Text}' and '{second.Text}' overlap");
                }
            }
        }

        // Every field reaches the paper whole, read line after line: nothing is shortened with an ellipsis. Texts at the left
        // edge are read on their own, so the amounts next to a line's name do not come in between.
        var atLeft = Squeezed(texts.Where(t => Math.Abs(t.X - PdfBuilder.Left) < Tolerance));
        foreach (var (field, value) in new[]
        {
            ("title", longest.Title), ("customer", longest.Customer.Name), ("street", longest.Customer.Street!),
            ("contact e-mail", longest.Customer.ContactEmail!), ("line name", lineName), ("link in the description", link),
            ("signature", longest.OwnerName!), ("signature e-mail", longest.OwnerEmail!),
        })
        {
            atLeft.ShouldContain(Squeezed(value), Case.Sensitive, field);
        }

        Squeezed(texts).ShouldContain(Squeezed(longest.CustomerReference!), Case.Sensitive, "customer reference");
        texts.ShouldNotContain(t => t.Text.Contains("...", StringComparison.Ordinal));
    }

    /// <summary>Repeats the words up to the length (trimmed), as a field filled to its column limit would be.</summary>
    private static string Words(string words, int length) =>
        string.Join(' ', Enumerable.Repeat(words, (length / words.Length) + 1))[..length].TrimEnd();

    private static string Squeezed(IEnumerable<PlacedText> texts) => Squeezed(string.Concat(texts.Select(t => t.Text)));

    private static string Squeezed(string text) => string.Concat(text.Where(c => !char.IsWhiteSpace(c)));

    private static QuoteSnapshot LongQuote(string language)
    {
        var monthly = Enumerable.Range(1, 34).Select(i => new QuoteSnapshotLine(
            i % 5 == 0 ? $"Microsoft 365 Business Premium med Defender for Business og Intune, brukerpakke {i} med et veldig langt navn" : $"Drift av arbeidsstasjon {i}",
            i % 3 == 0 ? $"Overvåking av brannmur, oppdateringer og sikkerhetskopiering for avdeling {i}. Inkluderer månedlig rapport, varsling ved hendelser og årlig gjennomgang av tilgangene." : null,
            $"SKU-{i:000}", i, 249.5m + i, i % 4 == 0 ? 10m : 0m, decimal.Round(i * (249.5m + i) * (i % 4 == 0 ? 0.9m : 1m), 2), true)).ToList();
        var oneTime = Enumerable.Range(1, 22).Select(i => new QuoteSnapshotLine(
            $"Etablering og migrering, fase {i}",
            i % 2 == 0 ? "Kartlegging, planlegging og flytting av e-post, filer og Teams-kanaler; opplæring av nøkkelbrukere på stedet." : null,
            null, 8m, 1_190m, 0m, 9_520m, false)).ToList();
        var lines = monthly.Concat(oneTime).ToList();
        var monthlyExVat = monthly.Sum(l => l.NetAmount);
        var oneTimeExVat = oneTime.Sum(l => l.NetAmount);
        return new QuoteSnapshot(
            "T-2026-0042",
            2,
            "Drift og forvaltning av Microsoft 365 og arbeidsstasjoner for hele konsernet",
            language,
            new DateOnly(2026, 10, 4),
            new DateOnly(2026, 11, 3),
            36,
            "Takk for en hyggelig prat. Her er vårt tilbud på drift og forvaltning, slik vi ble enige om på møtet. Prisene er faste i hele avtaleperioden.",
            string.Join('\n', Enumerable.Range(1, 6).Select(i => $"{i}. Leveransen følger Vardahei sine standard vilkår for drift og forvaltning, versjon 2026. Endringer avtales skriftlig og prises etter gjeldende timepris.")),
            "Bunntekst fra malen: tjenestene leveres etter avtalte vilkår.",
            "Innkjøp 2026-117",
            "Kari Nordmann",
            "kari.nordmann@example.no",
            new QuoteSnapshotCustomer("Fjellbekk Løsninger og Ærlige Bygg AS", "998 877 665", "Storgata 1", "5003", "Bergen", "Ola Åsheim", "ola.asheim@example.no"),
            lines,
            oneTimeExVat,
            decimal.Round(oneTimeExVat * 0.25m, 2),
            monthlyExVat,
            decimal.Round(monthlyExVat * 0.25m, 2),
            new QuoteSnapshotCompany("Vardahei AS", "923 456 789", "Eksempelveien 1", "5068", "Bergen", "post@example.no", "+47 00 00 00 00", "www.example.no"));
    }

    private static void Save(string name, byte[] bytes)
    {
        if (Environment.GetEnvironmentVariable("QUOTE_PDF_SAMPLES") is { Length: > 0 } folder)
        {
            Directory.CreateDirectory(folder);
            File.WriteAllBytes(Path.Combine(folder, name), bytes);
        }
    }

    private sealed record PlacedText(string Text, float X, float Baseline, float Width);

    /// <summary>The text of each page with its position (from the top) and width, read from the uncompressed content streams.</summary>
    private static List<List<PlacedText>> Pages(byte[] pdf)
    {
        var text = Encoding.Latin1.GetString(pdf);
        var pages = new List<List<PlacedText>>();
        foreach (Match stream in ContentStream().Matches(text))
        {
            var page = new List<PlacedText>();
            foreach (Match draw in TextDraw().Matches(stream.Groups[1].Value))
            {
                var style = draw.Groups["font"].Value == "2" ? PdfFontStyle.Bold : PdfFontStyle.Regular;
                var size = float.Parse(draw.Groups["size"].Value, CultureInfo.InvariantCulture);
                var value = Regex.Replace(draw.Groups["text"].Value, @"\\(.)", "$1");
                page.Add(new PlacedText(
                    value,
                    float.Parse(draw.Groups["x"].Value, CultureInfo.InvariantCulture),
                    PdfBuilder.A4Height - float.Parse(draw.Groups["y"].Value, CultureInfo.InvariantCulture),
                    PdfBuilder.Measure(value, size, style)));
            }

            pages.Add(page);
        }

        return pages;
    }

    [GeneratedRegex(@"stream\n(.*?)endstream", RegexOptions.Singleline)]
    private static partial Regex ContentStream();

    [GeneratedRegex(@"/F(?<font>\d) (?<size>[\d.]+) Tf 1 0 0 1 (?<x>[\d.]+) (?<y>[\d.]+) Tm \((?<text>(?:\\.|[^\\)])*)\) Tj ET")]
    private static partial Regex TextDraw();
}
