using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Crm.Backup.Contracts;
using Crm.Customers.Contracts;
using Crm.Reports;
using Crm.Service.Contracts;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>
/// Parasoll's monthly summary of a customer (M43), page by page: every part says its figures or plainly that there are none, in
/// Bokmål or English; a reconstructed summary says so under its title and in the footer of every page; every line stays inside the
/// margins and nothing is cut; no amount of money is printed; the same snapshot always gives the same bytes.
/// </summary>
public partial class CustomerMonthPdfTests
{
    private const float Tolerance = 0.6f;

    private static readonly DateTimeOffset Taken = new(2026, 10, 3, 5, 20, 0, TimeSpan.Zero);

    private static CustomerMonthSnapshot Snapshot(string language = "nb", StoredDocumentProvenance provenance = StoredDocumentProvenance.Captured,
        IReadOnlyList<AlertMonthCount>? alerts = null, string name = "Fjord IT AS", bool empty = false) => new(
        Guid.Parse("11111111-1111-1111-1111-111111111111"), name, "923609016", new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), language, provenance, Taken,
        new ServiceMonth(alerts ?? (empty ? [] : [
            new AlertMonthCount("atera", AlertSeverity.Critical, 2, 2, 0),
            new AlertMonthCount("huntress", AlertSeverity.Critical, 1, 0, 1),
            new AlertMonthCount("parasoll", AlertSeverity.Warning, 3, 1, 2),
        ]), empty ? 0 : 7, empty ? 0 : 6, empty ? 0 : 1),
        empty ? null : new DeviceMonth(new Dictionary<DeviceType, int> { [DeviceType.Workstation] = 1234, [DeviceType.Server] = 3 }, new DateOnly(2026, 9, 30)),
        empty ? [] : [new SecurityMonth("huntress", 4, 3, 1250, 40, 26)],
        empty ? null : new BackupState(Taken.AddHours(-2), true, [new BackupServiceState(BackupService.Mail, 12, 10, 1, 0, 0, 1, 0, Taken.AddHours(-3))]),
        empty ? null : 12.5m, empty ? null : 10m);

    [Fact]
    public void The_bokmal_summary_names_every_part_with_its_figures_and_no_money()
    {
        var bytes = CustomerMonthPdf.Render(Snapshot());
        PdfContent.Validate(bytes);
        var text = string.Join('\n', Pages(bytes).SelectMany(p => p).Select(t => t.Text));

        foreach (var expected in new[]
                 {
                     "Parasoll", "Månedsrapport", "Fjord IT AS", "September 2026 · Org.nr. 923609016", "Perioden 01.09.2026-30.09.2026, laget 03.10.2026.",
                     "DRIFTSVARSLER", "Atera", "Huntress", "Parasoll", "Kritisk", "Advarsel", "Sum", "SAKER I SERVICEDESKEN", "ENHETER VED MÅNEDSSLUTT",
                     "1 234", "Arbeidsstasjoner", "Servere", "Telling fra Atera 30.09.2026.", "SIKKERHET (HUNTRESS)", "Hendelser meldt", "1 250",
                     "SIKKERHETSKOPI (CLOUDALLY)", "E-post", "CloudAlly lest 03.10.2026.", "TIMER", "12,5 t", "10 t", "Side 1 av",
                 })
        {
            text.ShouldContain(expected, Case.Sensitive, $"'{expected}' is missing");
        }

        text.ShouldNotContain("Rekonstruert");
        text.ShouldNotContain(" kr");
        text.ShouldNotContain("NOK");
        // The fonts carry WinAnsi only: a narrow no-break space or a minus sign of ICU would print as a question mark.
        text.ShouldNotContain("?");
    }

    [Fact]
    public void The_english_summary_uses_its_own_words()
    {
        var text = string.Join('\n', Pages(CustomerMonthPdf.Render(Snapshot("en"))).SelectMany(p => p).Select(t => t.Text));
        foreach (var expected in new[] { "Monthly report", "September 2026 · Org. no. 923609016", "ALERTS", "Critical", "Warning", "SERVICE DESK TICKETS",
                     "DEVICES AT MONTH END", "1,234", "Workstations", "SECURITY (HUNTRESS)", "Incidents reported", "BACKUP (CLOUDALLY)", "Email", "12.5 h", "Page 1 of" })
        {
            text.ShouldContain(expected, Case.Sensitive, $"'{expected}' is missing");
        }
    }

    [Fact]
    public void An_empty_month_says_plainly_what_there_is_none_of()
    {
        var text = string.Join('\n', Pages(CustomerMonthPdf.Render(Snapshot(empty: true))).SelectMany(p => p).Select(t => t.Text));
        foreach (var expected in new[]
                 {
                     "Ingen driftsvarsler i måneden.", "Ingen enheter fra Atera i måneden.", "Ingen månedsrapport fra Huntress for måneden.",
                     "Ingen CloudAlly-konto koblet til kunden.", "Ingen godkjente timer i måneden.",
                 })
        {
            text.ShouldContain(expected, Case.Sensitive);
        }
    }

    [Theory]
    [InlineData("nb", "Rekonstruert 03.10.2026", "Side {0} av {1}")]
    [InlineData("en", "Reconstructed 03.10.2026", "Page {0} of {1}")]
    public void A_reconstructed_summary_says_so_under_its_title_and_on_every_page_with_every_line_inside_the_margins(string language, string footer, string pageLabel)
    {
        // Enough sources to run the alert table over a page, its header repeated.
        var alerts = Enumerable.Range(1, 70).Select(i => new AlertMonthCount($"source-{i:D2}-with-a-long-name", AlertSeverity.Warning, i, i / 2, i % 3)).ToList();
        var pages = Pages(CustomerMonthPdf.Render(Snapshot(language, StoredDocumentProvenance.Reconstructed, alerts,
            "Havbris Regnskap og Rådgivning Nordvest Avdeling Ålesund AS")));

        pages.Count.ShouldBeGreaterThan(1);
        for (var index = 0; index < pages.Count; index++)
        {
            var lines = pages[index];
            lines.ShouldContain(t => t.Text.StartsWith(footer, StringComparison.Ordinal) &&
                                     t.Text.EndsWith(string.Format(CultureInfo.InvariantCulture, pageLabel, index + 1, pages.Count), StringComparison.Ordinal));
            lines.ShouldAllBe(t => t.X >= PdfBuilder.Left - Tolerance && t.X + t.Width <= PdfBuilder.Right + Tolerance);
        }

        var all = string.Join(' ', pages.SelectMany(p => p).Select(t => t.Text));
        all.ShouldContain(language == "en" ? "Reconstructed: made 03.10.2026" : "Rekonstruert: laget 03.10.2026");
        // The long name is printed whole, wrapped, never cut with an ellipsis in the body.
        foreach (var word in "Havbris Regnskap og Rådgivning Nordvest Avdeling Ålesund AS".Split(' '))
        {
            all.ShouldContain(word);
        }

        pages[1].ShouldContain(t => t.Text == (language == "en" ? "Source" : "Kilde"), "the table's header comes again on the next page");
    }

    [Fact]
    public void The_same_snapshot_gives_the_same_bytes() =>
        CustomerMonthPdf.Render(Snapshot()).ShouldBe(CustomerMonthPdf.Render(Snapshot()));

    private sealed record PlacedText(string Text, float X, float Width);

    /// <summary>The text of each page with its position and width, read from the uncompressed content streams.</summary>
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
                var value = Regex.Replace(draw.Groups["text"].Value, @"\\(.)", "$1").Replace(' ', ' ');
                page.Add(new PlacedText(value, float.Parse(draw.Groups["x"].Value, CultureInfo.InvariantCulture), PdfBuilder.Measure(value, size, style)));
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
