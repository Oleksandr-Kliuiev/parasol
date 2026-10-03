using System.Globalization;
using Crm.SharedKernel.Documents;

namespace Crm.Sales.Features;

internal sealed record QuoteDocumentCustomer(
    string Name, string? OrgNumber, string? Street, string? PostalCode, string? City, string? ContactName, string? ContactEmail);

internal sealed record QuoteDocumentLine(
    string Name, string? Description, string? Sku, decimal Quantity, decimal UnitPrice, decimal DiscountPct, decimal NetAmount, bool Monthly);

internal sealed record QuoteDocument(
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
    QuoteDocumentCustomer Customer,
    IReadOnlyList<QuoteDocumentLine> Lines,
    decimal OneTimeExVat,
    decimal OneTimeVat,
    decimal MonthlyExVat,
    decimal MonthlyVat,
    QuoteCompanyOptions Company);

/// <summary>
/// Renders a quote as a PDF (FR-SAL-03). The document is drawn from the version itself and never stored: a version is
/// frozen once it leaves the house (BR-SAL-04), so re-rendering it always gives the same paper.
/// </summary>
internal static class QuotePdf
{
    private const float LabelSize = 8f;
    private const float BodySize = 9.5f;

    public static byte[] Render(QuoteDocument document)
    {
        var t = QuoteTexts.For(document.Language);
        var money = MoneyFormat(document.Language);
        var pdf = new PdfBuilder($"{t.Quote} {document.Number}");
        var company = document.Company;

        pdf.SetFooter((page, count) => string.Join(
            "   ·   ",
            new[]
            {
                company.Name,
                string.IsNullOrWhiteSpace(company.OrgNumber) ? null : $"{t.OrgNumber} {company.OrgNumber}",
                document.FooterText,
                string.Format(CultureInfo.InvariantCulture, t.Page, page, count),
            }.Where(part => !string.IsNullOrWhiteSpace(part))));

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
        pdf.DrawText(document.Title, PdfBuilder.Left, pdf.Y, 11.5f, PdfFontStyle.Regular, PdfColor.Grey);
        pdf.MoveDown(26f);

        // ---- Customer and meta, side by side ----
        var metaLeft = PdfBuilder.Left + (PdfBuilder.ContentWidth * 0.56f);
        var customerY = pdf.Y;
        pdf.DrawText(t.Customer.ToUpperInvariant(), PdfBuilder.Left, customerY, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        customerY += 14f;
        foreach (var part in CustomerBlock(document.Customer, t))
        {
            pdf.DrawText(part, PdfBuilder.Left, customerY, BodySize);
            customerY += BodySize * 1.4f;
        }

        var metaY = pdf.Y;
        foreach (var (label, value) in MetaRows(document, t))
        {
            pdf.DrawText(label.ToUpperInvariant(), metaLeft, metaY, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
            pdf.DrawTextRight(value, PdfBuilder.Right, metaY, BodySize);
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
        if (monthly.Count > 0)
        {
            Table(pdf, t.MonthlyServices, monthly, t, money, $"{t.TotalExVat} / {t.PerMonth}", document.MonthlyExVat);
        }

        if (oneTime.Count > 0)
        {
            Table(pdf, t.OneTimeItems, oneTime, t, money, t.TotalExVat, document.OneTimeExVat);
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
            pdf.MoveDown(16f);
            pdf.DrawText(document.OwnerName, PdfBuilder.Left, pdf.Y, BodySize, PdfFontStyle.Bold);
            if (!string.IsNullOrWhiteSpace(document.OwnerEmail))
            {
                pdf.MoveDown(BodySize * 1.4f);
                pdf.DrawText(document.OwnerEmail, PdfBuilder.Left, pdf.Y, BodySize, PdfFontStyle.Regular, PdfColor.Grey);
            }
        }

        return pdf.Build();
    }

    private static void Table(
        PdfBuilder pdf,
        string heading,
        IReadOnlyList<QuoteDocumentLine> lines,
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

        pdf.EnsureSpace(90f);
        pdf.MoveDown(6f);
        pdf.DrawText(heading.ToUpperInvariant(), PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Accent);
        pdf.MoveDown(10f);
        pdf.DrawText(t.Description, PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.DrawTextRight(t.Quantity, quantityRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.DrawTextRight(t.UnitPrice, priceRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.DrawTextRight(t.Discount, discountRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.DrawTextRight(t.Amount, amountRight, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.MoveDown(5f);
        pdf.DrawRule(pdf.Y);

        foreach (var line in lines)
        {
            IReadOnlyList<string> descriptionLines = string.IsNullOrWhiteSpace(line.Description)
                ? []
                : PdfBuilder.Wrap(line.Description, textWidth, LabelSize);
            var height = (BodySize * 1.5f) + (descriptionLines.Count * LabelSize * 1.3f) + 6f;
            if (pdf.EnsureSpace(height))
            {
                pdf.MoveDown(6f);
            }

            pdf.MoveDown(BodySize * 1.5f);
            pdf.DrawText(PdfBuilder.Ellipsize(line.Name, textWidth, BodySize), PdfBuilder.Left, pdf.Y, BodySize);
            pdf.DrawTextRight(Number(line.Quantity), quantityRight, pdf.Y, BodySize);
            pdf.DrawTextRight(money(line.UnitPrice), priceRight, pdf.Y, BodySize);
            pdf.DrawTextRight(line.DiscountPct > 0 ? $"{Number(line.DiscountPct)} %" : "–", discountRight, pdf.Y, BodySize);
            pdf.DrawTextRight(money(line.NetAmount), amountRight, pdf.Y, BodySize);
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

    private static IEnumerable<string> CustomerBlock(QuoteDocumentCustomer customer, QuoteTexts t)
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

    private static IEnumerable<(string Label, string Value)> MetaRows(QuoteDocument document, QuoteTexts t)
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
    string Page)
{
    private static readonly QuoteTexts Norwegian = new(
        "Tilbud", "Kunde", "Att.", "Org.nr", "Dato", "Gyldig til", "Avtaleperiode", "mnd.", "Vår referanse", "Deres referanse",
        "Beskrivelse", "Antall", "Enhetspris", "Rabatt", "Beløp", "Månedlige tjenester", "Engangsposter", "Per måned",
        "Sum eks. mva.", "Mva.", "Sum inkl. mva.", "Samlet avtaleverdi", "Vilkår",
        "Alle priser er i norske kroner og eksklusive merverdiavgift der ikke annet er oppgitt.",
        "Tilbudet er gyldig til {0}. Ta gjerne kontakt om noe er uklart.",
        "Side {0} av {1}");

    private static readonly QuoteTexts English = new(
        "Quote", "Customer", "Attn.", "Org. no.", "Date", "Valid until", "Contract term", "months", "Our reference", "Your reference",
        "Description", "Quantity", "Unit price", "Discount", "Amount", "Monthly services", "One-time items", "Per month",
        "Total excl. VAT", "VAT", "Total incl. VAT", "Total contract value", "Terms",
        "All prices are in Norwegian kroner and exclude VAT unless stated otherwise.",
        "This quote is valid until {0}. Please get in touch if anything is unclear.",
        "Page {0} of {1}");

    public static QuoteTexts For(string language) => language is "en" ? English : Norwegian;
}
