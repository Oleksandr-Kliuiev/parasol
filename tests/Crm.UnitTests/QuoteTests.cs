using System.Text;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

public class QuoteDomainTests
{
    private static readonly DateOnly Today = new(2026, 9, 16);

    private static Quote NewQuote(params QuoteLineData[] lines)
    {
        var quote = Quote.Create("T-2026-0001", Header(), Today).Value;
        quote.ReplaceLines(lines).IsSuccess.ShouldBeTrue();
        return quote;
    }

    private static QuoteHeader Header() => new(
        Guid.NewGuid(), null, null, "Managed Microsoft 365", Guid.NewGuid(), "nb", Today.AddDays(30), 24, "Intro", "Terms", null);

    private static QuoteLineData Line(decimal quantity, decimal unitPrice, decimal discount, QuoteLineRecurrence recurrence) =>
        new(Guid.NewGuid(), "SKU", "M365 Business Premium", null, quantity, unitPrice, discount, recurrence, 25m);

    [Fact]
    public void Totals_split_monthly_and_one_time_lines()
    {
        var quote = NewQuote(
            Line(25, 250m, 0m, QuoteLineRecurrence.Monthly),
            Line(20, 1_190m, 10m, QuoteLineRecurrence.OneTime));

        quote.MonthlyExVat.ShouldBe(6_250m);
        quote.OneTimeExVat.ShouldBe(21_420m);
        quote.MonthlyVat.ShouldBe(1_562.50m);
        // Over the quoted 24 months: the implementation once plus the monthly fee.
        quote.ContractValue.ShouldBe(21_420m + (6_250m * 24));
    }

    [Fact]
    public void A_line_discount_is_applied_before_rounding()
    {
        var quote = NewQuote(Line(3, 333.33m, 12.5m, QuoteLineRecurrence.OneTime));

        quote.OneTimeExVat.ShouldBe(874.99m);
    }

    [Fact]
    public void A_quote_within_the_discount_limit_is_released_at_once()
    {
        var quote = NewQuote(Line(10, 100m, 10m, QuoteLineRecurrence.Monthly));

        quote.Submit(15m, false, Guid.NewGuid(), DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();

        quote.Status.ShouldBe(QuoteStatus.Ready);
        quote.HasDocument.ShouldBeTrue();
    }

    [Fact]
    public void A_discount_above_the_limit_waits_for_management_and_has_no_document()
    {
        var quote = NewQuote(Line(10, 100m, 20m, QuoteLineRecurrence.Monthly));
        var salesperson = Guid.NewGuid();

        quote.Submit(15m, false, salesperson, DateTimeOffset.UtcNow);

        quote.Status.ShouldBe(QuoteStatus.PendingApproval);
        quote.ApprovalRequestedBy.ShouldBe(salesperson);
        quote.HasDocument.ShouldBeFalse();

        var manager = Guid.NewGuid();
        quote.Approve(manager, DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();
        quote.Status.ShouldBe(QuoteStatus.Ready);
        quote.ApprovedBy.ShouldBe(manager);
        quote.HasDocument.ShouldBeTrue();
    }

    [Fact]
    public void Someone_who_may_approve_discounts_releases_the_quote_themselves()
    {
        var quote = NewQuote(Line(10, 100m, 40m, QuoteLineRecurrence.Monthly));
        var manager = Guid.NewGuid();

        quote.Submit(15m, true, manager, DateTimeOffset.UtcNow);

        quote.Status.ShouldBe(QuoteStatus.Ready);
        quote.ApprovedBy.ShouldBe(manager);
    }

    [Fact]
    public void A_rejected_discount_sends_the_quote_back_to_draft_with_the_reason()
    {
        var quote = NewQuote(Line(10, 100m, 30m, QuoteLineRecurrence.Monthly));
        quote.Submit(15m, false, Guid.NewGuid(), DateTimeOffset.UtcNow);

        quote.Reject("Margin too thin on hardware.").IsSuccess.ShouldBeTrue();

        quote.Status.ShouldBe(QuoteStatus.Draft);
        quote.RejectedReason.ShouldBe("Margin too thin on hardware.");
        quote.Reject("again").IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public void A_sent_quote_cannot_be_edited()
    {
        var quote = NewQuote(Line(1, 1_000m, 0m, QuoteLineRecurrence.OneTime));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.MarkSent(Guid.NewGuid(), "kunde@example.no", DateTimeOffset.UtcNow);

        var edited = quote.ReplaceLines([Line(2, 1_000m, 0m, QuoteLineRecurrence.OneTime)]);

        edited.IsSuccess.ShouldBeFalse();
        edited.Error!.Code.ShouldBe("SAL_QUOTE_NOT_EDITABLE");
        quote.Update(Header(), Today).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public void Editing_a_released_quote_makes_it_a_draft_again()
    {
        var quote = NewQuote(Line(1, 1_000m, 0m, QuoteLineRecurrence.OneTime));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.Status.ShouldBe(QuoteStatus.Ready);

        quote.ReplaceLines([Line(1, 1_000m, 25m, QuoteLineRecurrence.OneTime)]).IsSuccess.ShouldBeTrue();

        quote.Status.ShouldBe(QuoteStatus.Draft);
        quote.MaxDiscountPct.ShouldBe(25m);
    }

    [Fact]
    public void A_new_version_copies_the_lines_and_leaves_the_old_one_as_history()
    {
        var quote = NewQuote(Line(25, 250m, 0m, QuoteLineRecurrence.Monthly));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.MarkSent(null, "kunde@example.no", DateTimeOffset.UtcNow);

        var second = quote.Revise(Today.AddDays(5), 30).Value;

        quote.Status.ShouldBe(QuoteStatus.Superseded);
        second.VersionNo.ShouldBe(2);
        second.Number.ShouldBe(quote.Number);
        second.RootId.ShouldBe(quote.RootId);
        second.Status.ShouldBe(QuoteStatus.Draft);
        second.Lines.Count.ShouldBe(1);
        second.MonthlyExVat.ShouldBe(quote.MonthlyExVat);
        second.ValidUntil.ShouldBe(Today.AddDays(35));
    }

    [Fact]
    public void An_accepted_quote_cannot_be_revised_or_accepted_twice()
    {
        var quote = NewQuote(Line(25, 250m, 0m, QuoteLineRecurrence.Monthly));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.MarkSent(null, "kunde@example.no", DateTimeOffset.UtcNow);

        quote.Accept(Today).IsSuccess.ShouldBeTrue();

        quote.Status.ShouldBe(QuoteStatus.Accepted);
        quote.Accept(Today).IsSuccess.ShouldBeFalse();
        quote.Revise(Today, 30).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public void Accepting_a_quote_hands_the_lines_on_to_contracts_and_billing()
    {
        var quote = NewQuote(
            Line(25, 250m, 0m, QuoteLineRecurrence.Monthly),
            Line(20, 1_190m, 0m, QuoteLineRecurrence.OneTime));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.MarkSent(null, "kunde@example.no", DateTimeOffset.UtcNow);

        quote.Accept(Today);

        var accepted = quote.DomainEvents.OfType<QuoteAccepted>().Single();
        accepted.Number.ShouldBe("T-2026-0001");
        accepted.TermMonths.ShouldBe(24);
        accepted.Lines.Count(l => l.Recurrence == QuoteLineRecurrence.Monthly).ShouldBe(1);
        accepted.Lines.Count(l => l.Recurrence == QuoteLineRecurrence.OneTime).ShouldBe(1);
        accepted.Lines.ShouldAllBe(l => l.VatRate == 25m);
    }

    [Fact]
    public void A_sent_quote_expires_the_day_after_its_validity_ends()
    {
        var quote = NewQuote(Line(1, 1_000m, 0m, QuoteLineRecurrence.OneTime));
        quote.Submit(15m, false, null, DateTimeOffset.UtcNow);
        quote.MarkSent(null, "kunde@example.no", DateTimeOffset.UtcNow);

        quote.Expire(quote.ValidUntil).ShouldBeFalse();
        quote.Expire(quote.ValidUntil.AddDays(1)).ShouldBeTrue();
        quote.Status.ShouldBe(QuoteStatus.Expired);
        // An expired quote is history but can still be picked up as a new version.
        quote.Revise(Today, 30).IsSuccess.ShouldBeTrue();
    }

    [Fact]
    public void An_empty_quote_is_not_released()
    {
        var quote = Quote.Create("T-2026-0002", Header(), Today).Value;

        quote.Submit(15m, false, null, DateTimeOffset.UtcNow).Error!.Code.ShouldBe("SAL_QUOTE_EMPTY");
    }
}

public class PdfBuilderTests
{
    [Fact]
    public void A_document_is_a_readable_pdf_with_a_valid_cross_reference_table()
    {
        var pdf = new PdfBuilder("Tilbud T-2026-0001");
        pdf.Paragraph("Tilbud på drift av Microsoft 365 for Åsane Rør & Blikk AS.");
        pdf.DrawTextRight("12 500,00", PdfBuilder.Right, 200f, 9.5f);
        pdf.NewPage();
        pdf.Paragraph("Vilkår");
        pdf.SetFooter((page, count) => $"Side {page} av {count}");

        var bytes = pdf.Build();
        var text = Encoding.Latin1.GetString(bytes);

        text.ShouldStartWith("%PDF-1.7");
        text.TrimEnd().ShouldEndWith("%%EOF");
        text.ShouldContain("/Count 2");
        text.ShouldContain("/BaseFont /Helvetica-Bold");
        // Norwegian letters are written as WinAnsi bytes, not as escapes or question marks.
        text.ShouldContain("Åsane Rør & Blikk");
        OffsetsPointAtObjects(text).ShouldBeTrue();
    }

    [Fact]
    public void Brackets_and_backslashes_in_text_are_escaped()
    {
        var pdf = new PdfBuilder("t");
        pdf.Paragraph("Rabatt (25 %) \\ pakke");

        var text = Encoding.Latin1.GetString(pdf.Build());

        text.ShouldContain("Rabatt \\(25 %\\) \\\\ pakke");
    }

    [Fact]
    public void Text_outside_winansi_becomes_a_question_mark_instead_of_broken_bytes()
    {
        var pdf = new PdfBuilder("t");
        pdf.Paragraph("Предложение");

        Encoding.Latin1.GetString(pdf.Build()).ShouldContain("???????????");
    }

    [Theory]
    [InlineData("0")]
    [InlineData("1 234,50")]
    [InlineData("-99,00")]
    public void Digits_measure_exactly_so_amounts_line_up(string amount)
    {
        var expected = amount.Sum(c => c switch { ' ' or ',' or '.' => 278, '-' => 333, _ => 556 }) * 9.5f / 1000f;

        PdfBuilder.Measure(amount, 9.5f).ShouldBe(expected, 0.001f);
    }

    [Fact]
    public void Wrapping_keeps_every_line_within_the_width()
    {
        var lines = PdfBuilder.Wrap("Drift og overvåking av servere, brannmur og sikkerhetskopiering for hele selskapet.", 180f, 9.5f);

        lines.Count.ShouldBeGreaterThan(1);
        lines.ShouldAllBe(line => PdfBuilder.Measure(line, 9.5f) <= 180f);
    }

    private static bool OffsetsPointAtObjects(string text)
    {
        // "startxref" also ends in "xref", so the table is found by its own line.
        var xrefIndex = text.LastIndexOf("\nxref\n", StringComparison.Ordinal) + 1;
        var lines = text[xrefIndex..].Split('\n');
        var count = int.Parse(lines[1].Split(' ')[1], System.Globalization.CultureInfo.InvariantCulture);
        for (var number = 1; number < count; number++)
        {
            var offset = int.Parse(lines[number + 2][..10], System.Globalization.CultureInfo.InvariantCulture);
            if (!text[offset..].StartsWith($"{number} 0 obj", StringComparison.Ordinal))
            {
                return false;
            }
        }

        return true;
    }
}
