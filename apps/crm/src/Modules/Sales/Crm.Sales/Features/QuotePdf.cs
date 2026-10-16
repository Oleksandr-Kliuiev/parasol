using System.Globalization;
using System.Text.Json;
using Crm.SharedKernel.Documents;

namespace Crm.Sales.Features;

internal sealed record QuoteSnapshotCustomer(
    string Name, string? OrgNumber, string? Street, string? PostalCode, string? City, string? ContactName, string? ContactEmail);

internal sealed record QuoteSnapshotLine(
    string Name, string? Description, string? Sku, decimal Quantity, decimal UnitPrice, decimal DiscountPct, decimal NetAmount, bool Monthly);

/// <summary>The seller as the document names it, copied from the company settings when the document is frozen.</summary>
internal sealed record QuoteSnapshotCompany(
    string Name, string? OrgNumber, string? Street, string? PostalCode, string? City, string? Email, string? Phone, string? Website)
{
    public static QuoteSnapshotCompany From(QuoteCompanyOptions options) => new(
        options.Name, options.OrgNumber, options.Street, options.PostalCode, options.City, options.Email, options.Phone, options.Website);
}

/// <summary>
/// Every field of a quote document, frozen when the version is released (DEV-08): the stored PDF is drawn from this and
/// from nothing else, so it records exactly what the customer was shown. <see cref="ReconstructedOn"/> marks a document drawn
/// later for a version released before documents were stored.
/// </summary>
internal sealed record QuoteSnapshot(
    string Number,
    int VersionNo,
    string Title,
    string Language,
    DateOnly IssuedOn,
    DateOnly ValidUntil,
    int TermMonths,
    string? IntroText,
    string? TermsText,
    string? FooterText,
    string? CustomerReference,
    string? OwnerName,
    string? OwnerEmail,
    QuoteSnapshotCustomer Customer,
    IReadOnlyList<QuoteSnapshotLine> Lines,
    decimal OneTimeExVat,
    decimal OneTimeVat,
    decimal MonthlyExVat,
    decimal MonthlyVat,
    QuoteSnapshotCompany Company,
    Guid? TemplateId = null,
    string? TemplateName = null,
    DateOnly? ReconstructedOn = null)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public string ToJson() => JsonSerializer.Serialize(this, JsonOptions);

    public static QuoteSnapshot FromJson(string json) => JsonSerializer.Deserialize<QuoteSnapshot>(json, JsonOptions)!;
}

/// <summary>
/// Renders a quote document as a PDF (FR-SAL-03) from its frozen snapshot. The result is stored when the document becomes
/// Ready and served from storage afterwards (DEV-08): changing this renderer never changes a document that exists.
/// </summary>
internal static class QuotePdf
{
    /// <summary>Recorded with every stored document; bump it whenever the output of the renderer changes.</summary>
    public const string RendererVersion = "quote-pdf/2";

    private const float LabelSize = 8f;
    private const float BodySize = 9.5f;

    public static byte[] Render(QuoteSnapshot document)
    {
        var t = QuoteTexts.For(document.Language);
        var money = MoneyFormat(document.Language);
        var pdf = new PdfBuilder($"{t.Quote} {document.Number}");
        var company = document.Company;

        pdf.SetFooter((page, count) => Footer(document, t, page, count));

        // ---- Letterhead ----
        pdf.Y = PdfBuilder.Margin + 6f;
        pdf.DrawText(company.Name, PdfBuilder.Left, pdf.Y, 15f, PdfFontStyle.Bold, PdfColor.Accent);
        var contact = new[] { company.Street, Join(company.PostalCode, company.City), company.Phone, company.Email, company.Website }
            .Where(part => !string.IsNullOrWhiteSpace(part))
            .ToList();
        var right = pdf.Y - 3f;
        foreach (var part in contact)
        {
            pdf.DrawTextRight(part!, PdfBuilder.Right, right, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
            right += LabelSize * 1.35f;
        }

        pdf.Y = Math.Max(pdf.Y + 22f, right + 6f);
        pdf.DrawRule(pdf.Y, color: PdfColor.Accent, thickness: 1.2f);
        pdf.MoveDown(30f);

        // ---- Title ----
        pdf.DrawText($"{t.Quote} {document.Number}" + (document.VersionNo > 1 ? $" · v{document.VersionNo}" : string.Empty), PdfBuilder.Left, pdf.Y, 19f, PdfFontStyle.Bold);
        pdf.MoveDown(18f);
        pdf.Y = DrawWrapped(pdf, document.Title, PdfBuilder.Left, pdf.Y, PdfBuilder.ContentWidth, 11.5f, PdfFontStyle.Regular, PdfColor.Grey);
        pdf.MoveDown(26f);

        if (document.ReconstructedOn is { } reconstructedOn)
        {
            // Never passed off as the paper that was sent: a version released before documents were stored (DEV-08).
            pdf.Paragraph(string.Format(CultureInfo.InvariantCulture, t.ReconstructedNote, Date(reconstructedOn)), BodySize, color: PdfColor.Accent);
            pdf.MoveDown(24f);
        }

        // ---- Customer and meta, side by side ----
        // Every field is printed whole: what does not fit its column continues on the next line.
        var metaLeft = PdfBuilder.Left + (PdfBuilder.ContentWidth * 0.56f);
        var customerY = pdf.Y;
        pdf.DrawText(t.Customer.ToUpperInvariant(), PdfBuilder.Left, customerY, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        customerY += 14f;
        foreach (var part in CustomerBlock(document.Customer, t))
        {
            customerY = DrawWrapped(pdf, part, PdfBuilder.Left, customerY, metaLeft - PdfBuilder.Left - 14f, BodySize) + (BodySize * 1.4f);
        }

        var metaRows = MetaRows(document, t).Select(row => (Label: row.Label.ToUpperInvariant(), row.Value)).ToList();
        var valueWidth = PdfBuilder.Right - metaLeft - metaRows.Max(row => PdfBuilder.Measure(row.Label, LabelSize, PdfFontStyle.Bold)) - 12f;
        var metaY = pdf.Y;
        foreach (var (label, value) in metaRows)
        {
            pdf.DrawText(label, metaLeft, metaY, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            var valueLines = PdfBuilder.Wrap(value, valueWidth, BodySize);
            for (var index = 0; index < valueLines.Count; index++)
            {
                metaY += index == 0 ? 0f : BodySize * 1.3f;
                pdf.DrawTextRight(valueLines[index], PdfBuilder.Right, metaY, BodySize);
            }

            metaY += BodySize * 1.7f;
        }

        pdf.Y = Math.Max(customerY, metaY) + 14f;

        if (!string.IsNullOrWhiteSpace(document.IntroText))
        {
            pdf.Paragraph(document.IntroText, BodySize);
            pdf.MoveDown(12f);
        }

        // ---- Lines ----
        var monthly = document.Lines.Where(l => l.Monthly).ToList();
        var oneTime = document.Lines.Where(l => !l.Monthly).ToList();
        var reference = $"{t.Quote} {document.Number}" + (document.VersionNo > 1 ? $" · v{document.VersionNo}" : string.Empty);
        if (monthly.Count > 0)
        {
            Table(pdf, t.MonthlyServices, reference, monthly, t, money, $"{t.TotalExVat} / {t.PerMonth}", document.MonthlyExVat);
        }

        if (oneTime.Count > 0)
        {
            Table(pdf, t.OneTimeItems, reference, oneTime, t, money, t.TotalExVat, document.OneTimeExVat);
        }

        // ---- Summary ----
        pdf.EnsureSpace(120f);
        pdf.MoveDown(18f);
        var summaryTop = pdf.Y - 12f;
        var summaryLeft = PdfBuilder.Left + (PdfBuilder.ContentWidth * 0.42f);
        var rows = new List<(string Label, decimal Value, bool Strong)>();
        if (monthly.Count > 0)
        {
            rows.Add(($"{t.PerMonth} · {t.TotalExVat}", document.MonthlyExVat, false));
            rows.Add(($"{t.PerMonth} · {t.Vat}", document.MonthlyVat, false));
            rows.Add(($"{t.PerMonth} · {t.TotalInclVat}", document.MonthlyExVat + document.MonthlyVat, true));
        }

        if (oneTime.Count > 0)
        {
            rows.Add(($"{t.OneTimeItems} · {t.TotalExVat}", document.OneTimeExVat, false));
            rows.Add(($"{t.OneTimeItems} · {t.Vat}", document.OneTimeVat, false));
            rows.Add(($"{t.OneTimeItems} · {t.TotalInclVat}", document.OneTimeExVat + document.OneTimeVat, true));
        }

        if (document.TermMonths > 0 && monthly.Count > 0)
        {
            rows.Add(($"{t.ContractValue} ({document.TermMonths} {t.Months})", document.OneTimeExVat + (document.MonthlyExVat * document.TermMonths), true));
        }

        pdf.DrawRect(summaryLeft, summaryTop, PdfBuilder.Right - summaryLeft, (rows.Count * BodySize * 1.7f) + 20f, PdfColor.Band);
        foreach (var (label, value, strong) in rows)
        {
            pdf.MoveDown(BodySize * 1.7f);
            var style = strong ? PdfFontStyle.Bold : PdfFontStyle.Regular;
            pdf.DrawText(label, summaryLeft + 12f, pdf.Y, BodySize, style);
            pdf.DrawTextRight(money(value), PdfBuilder.Right - 12f, pdf.Y, BodySize, style);
        }

        pdf.MoveDown(24f);
        pdf.DrawText(t.PriceNote, PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
        pdf.MoveDown(24f);

        // ---- Terms ----
        if (!string.IsNullOrWhiteSpace(document.TermsText))
        {
            pdf.EnsureSpace(80f);
            pdf.DrawText(t.Terms.ToUpperInvariant(), PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.MoveDown(6f);
            pdf.Paragraph(document.TermsText, BodySize, color: PdfColor.Black);
            pdf.MoveDown(14f);
        }

        pdf.EnsureSpace(40f);
        pdf.Paragraph(string.Format(CultureInfo.InvariantCulture, t.ValiditySentence, Date(document.ValidUntil)), BodySize);
        if (!string.IsNullOrWhiteSpace(document.OwnerName))
        {
            var signatureLines = PdfBuilder.Wrap(document.OwnerName, PdfBuilder.ContentWidth, BodySize, PdfFontStyle.Bold).Count +
                (string.IsNullOrWhiteSpace(document.OwnerEmail) ? 0 : PdfBuilder.Wrap(document.OwnerEmail, PdfBuilder.ContentWidth, BodySize).Count);
            pdf.EnsureSpace(16f + (signatureLines * BodySize * 1.4f));
            pdf.MoveDown(16f);
            pdf.Y = DrawWrapped(pdf, document.OwnerName, PdfBuilder.Left, pdf.Y, PdfBuilder.ContentWidth, BodySize, PdfFontStyle.Bold);
            if (!string.IsNullOrWhiteSpace(document.OwnerEmail))
            {
                pdf.MoveDown(BodySize * 1.4f);
                pdf.Y = DrawWrapped(pdf, document.OwnerEmail, PdfBuilder.Left, pdf.Y, PdfBuilder.ContentWidth, BodySize, PdfFontStyle.Regular, PdfColor.Grey);
            }
        }

        return pdf.Build();
    }

    private const string FooterSeparator = "   ·   ";
    private const float FooterSize = 8f;

    /// <summary>
    /// One line under every page. The page numbers always fit: when the line would run past the margin, the free footer text
    /// of the template gives way (it is kept whole in the snapshot).
    /// </summary>
    internal static string Footer(QuoteSnapshot document, QuoteTexts t, int page, int count)
    {
        var company = document.Company;
        string Compose(string? footerText) => string.Join(
            FooterSeparator,
            new[]
            {
                document.ReconstructedOn is { } reconstructed ? string.Format(CultureInfo.InvariantCulture, t.ReconstructedFooter, Date(reconstructed)) : null,
                company.Name,
                string.IsNullOrWhiteSpace(company.OrgNumber) ? null : $"{t.OrgNumber} {company.OrgNumber}",
                footerText,
                string.Format(CultureInfo.InvariantCulture, t.Page, page, count),
            }.Where(part => !string.IsNullOrWhiteSpace(part)));

        var full = Compose(document.FooterText);
        if (PdfBuilder.Measure(full, FooterSize) <= PdfBuilder.ContentWidth || string.IsNullOrWhiteSpace(document.FooterText))
        {
            return full;
        }

        var room = PdfBuilder.ContentWidth - PdfBuilder.Measure(Compose(null) + FooterSeparator, FooterSize);
        return room >= 40f ? Compose(PdfBuilder.Ellipsize(document.FooterText, room, FooterSize)) : Compose(null);
    }

    private static void Table(
        PdfBuilder pdf,
        string heading,
        string reference,
        IReadOnlyList<QuoteSnapshotLine> lines,
        QuoteTexts t,
        Func<decimal, string> money,
        string totalLabel,
        decimal total)
    {
        var amountRight = PdfBuilder.Right;
        var discountRight = amountRight - 86f;
        var priceRight = discountRight - 48f;
        var quantityRight = priceRight - 76f;
        var textWidth = quantityRight - PdfBuilder.Left - 54f;

        // On a page the table continues onto, the reader still sees which quote and section it is and what the columns are.
        void Header(bool continued)
        {
            if (continued)
            {
                pdf.MoveDown(6f);
                pdf.DrawText(reference, PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
                pdf.MoveDown(14f);
            }

            pdf.DrawText((continued ? $"{heading} ({t.Continued})" : heading).ToUpperInvariant(), PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Accent);
            pdf.MoveDown(10f);
            pdf.DrawText(t.Description, PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.DrawTextRight(t.Quantity, quantityRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.DrawTextRight(t.UnitPrice, priceRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.DrawTextRight(t.Discount, discountRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.DrawTextRight(t.Amount, amountRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.MoveDown(5f);
            pdf.DrawRule(pdf.Y);
        }

        pdf.EnsureSpace(90f);
        pdf.MoveDown(6f);
        Header(continued: false);

        foreach (var line in lines)
        {
            var nameLines = PdfBuilder.Wrap(line.Name, textWidth, BodySize);
            IReadOnlyList<string> descriptionLines = string.IsNullOrWhiteSpace(line.Description)
                ? []
                : PdfBuilder.Wrap(line.Description, textWidth, LabelSize);
            var height = (BodySize * 1.5f) + ((nameLines.Count - 1) * BodySize * 1.3f) + (descriptionLines.Count * LabelSize * 1.3f) + 6f;
            if (pdf.EnsureSpace(height))
            {
                Header(continued: true);
            }

            pdf.MoveDown(BodySize * 1.5f);
            pdf.DrawText(nameLines[0], PdfBuilder.Left, pdf.Y, BodySize);
            pdf.DrawTextRight(Number(line.Quantity), quantityRight, pdf.Y, BodySize);
            pdf.DrawTextRight(money(line.UnitPrice), priceRight, pdf.Y, BodySize);
            pdf.DrawTextRight(line.DiscountPct > 0 ? $"{Number(line.DiscountPct)} %" : "–", discountRight, pdf.Y, BodySize);
            pdf.DrawTextRight(money(line.NetAmount), amountRight, pdf.Y, BodySize);
            // The whole name of what is offered: a quote never shortens it.
            foreach (var part in nameLines.Skip(1))
            {
                pdf.MoveDown(BodySize * 1.3f);
                pdf.DrawText(part, PdfBuilder.Left, pdf.Y, BodySize);
            }

            foreach (var part in descriptionLines)
            {
                pdf.MoveDown(LabelSize * 1.3f);
                pdf.DrawText(part, PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
            }

            pdf.MoveDown(6f);
            pdf.DrawRule(pdf.Y, color: PdfColor.Band);
        }

        pdf.MoveDown(BodySize * 1.6f);
        pdf.DrawTextRight(totalLabel, discountRight, pdf.Y, BodySize, PdfFontStyle.Bold);
        pdf.DrawTextRight(money(total), amountRight, pdf.Y, BodySize, PdfFontStyle.Bold);
        pdf.MoveDown(10f);
    }

    /// <summary>Draws text wrapped to the width from the baseline down; returns the baseline of its last line.</summary>
    private static float DrawWrapped(PdfBuilder pdf, string text, float x, float baseline, float width, float size, PdfFontStyle style = PdfFontStyle.Regular, PdfColor? color = null)
    {
        var lines = PdfBuilder.Wrap(text, width, size, style);
        for (var index = 0; index < lines.Count; index++)
        {
            baseline += index == 0 ? 0f : size * 1.3f;
            pdf.DrawText(lines[index], x, baseline, size, style, color);
        }

        return baseline;
    }

    private static IEnumerable<string> CustomerBlock(QuoteSnapshotCustomer customer, QuoteTexts t)
    {
        yield return customer.Name;
        if (!string.IsNullOrWhiteSpace(customer.OrgNumber))
        {
            yield return $"{t.OrgNumber} {customer.OrgNumber}";
        }

        if (!string.IsNullOrWhiteSpace(customer.Street))
        {
            yield return customer.Street;
        }

        if (Join(customer.PostalCode, customer.City) is { Length: > 0 } place)
        {
            yield return place;
        }

        if (!string.IsNullOrWhiteSpace(customer.ContactName))
        {
            yield return $"{t.Attention} {customer.ContactName}";
        }

        if (!string.IsNullOrWhiteSpace(customer.ContactEmail))
        {
            yield return customer.ContactEmail;
        }
    }

    private static IEnumerable<(string Label, string Value)> MetaRows(QuoteSnapshot document, QuoteTexts t)
    {
        yield return (t.Date, Date(document.IssuedOn));
        yield return (t.ValidUntil, Date(document.ValidUntil));
        if (document.TermMonths > 0)
        {
            yield return (t.ContractTerm, $"{document.TermMonths} {t.Months}");
        }

        if (!string.IsNullOrWhiteSpace(document.OwnerName))
        {
            yield return (t.OurReference, document.OwnerName);
        }

        if (!string.IsNullOrWhiteSpace(document.CustomerReference))
        {
            yield return (t.YourReference, document.CustomerReference);
        }
    }

    private static string Join(string? postalCode, string? city) =>
        string.Join(' ', new[] { postalCode, city }.Where(part => !string.IsNullOrWhiteSpace(part)));

    private static string Date(DateOnly date) => date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);

    /// <summary>Amounts are grouped by spaces with a decimal comma in Norwegian and a decimal point in English.</summary>
    internal static Func<decimal, string> MoneyFormat(string language)
    {
        var format = new NumberFormatInfo
        {
            NumberGroupSeparator = " ",
            NumberDecimalSeparator = language is "en" ? "." : ",",
            NumberDecimalDigits = 2,
        };
        return value => value.ToString("N2", format);
    }

    private static string Number(decimal value) =>
        value == decimal.Truncate(value)
            ? value.ToString("0", CultureInfo.InvariantCulture)
            : value.ToString("0.##", CultureInfo.InvariantCulture);
}

/// <summary>The words on the document itself, in the customer's language — separate from the CRM interface translations.</summary>
internal sealed record QuoteTexts(
    string Quote,
    string Customer,
    string Attention,
    string OrgNumber,
    string Date,
    string ValidUntil,
    string ContractTerm,
    string Months,
    string OurReference,
    string YourReference,
    string Description,
    string Quantity,
    string UnitPrice,
    string Discount,
    string Amount,
    string MonthlyServices,
    string OneTimeItems,
    string PerMonth,
    string TotalExVat,
    string Vat,
    string TotalInclVat,
    string ContractValue,
    string Terms,
    string PriceNote,
    string ValiditySentence,
    string Page,
    string ReconstructedNote,
    string ReconstructedFooter,
    string Continued)
{
    private static readonly QuoteTexts Norwegian = new(
        "Tilbud", "Kunde", "Att.", "Org.nr", "Dato", "Gyldig til", "Avtaleperiode", "mnd.", "Vår referanse", "Deres referanse",
        "Beskrivelse", "Antall", "Enhetspris", "Rabatt", "Beløp", "Månedlige tjenester", "Engangsposter", "Per måned",
        "Sum eks. mva.", "Mva.", "Sum inkl. mva.", "Samlet avtaleverdi", "Vilkår",
        "Alle priser er i norske kroner og eksklusive merverdiavgift der ikke annet er oppgitt.",
        "Tilbudet er gyldig til {0}. Ta gjerne kontakt om noe er uklart.",
        "Side {0} av {1}",
        "Gjenskapt kopi, laget {0} med opplysningene som gjaldt da. Dette er ikke dokumentet som ble sendt; originalen ble ikke lagret.",
        "Gjenskapt kopi {0}",
        "forts.");

    private static readonly QuoteTexts English = new(
        "Quote", "Customer", "Attn.", "Org. no.", "Date", "Valid until", "Contract term", "months", "Our reference", "Your reference",
        "Description", "Quantity", "Unit price", "Discount", "Amount", "Monthly services", "One-time items", "Per month",
        "Total excl. VAT", "VAT", "Total incl. VAT", "Total contract value", "Terms",
        "All prices are in Norwegian kroner and exclude VAT unless stated otherwise.",
        "This quote is valid until {0}. Please get in touch if anything is unclear.",
        "Page {0} of {1}",
        "Reconstructed copy, made on {0} from the data of that day. This is not the document that was sent; the original was not stored.",
        "Reconstructed copy {0}",
        "cont.");

    public static QuoteTexts For(string language) => language is "en" ? English : Norwegian;
}
