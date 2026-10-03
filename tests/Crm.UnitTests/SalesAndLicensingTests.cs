using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Licensing.Contracts;
using Crm.Licensing.Domain;
using Crm.Licensing.Features;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;

namespace Crm.UnitTests;

public class OpportunityTests
{
    private static readonly Guid Stage = Guid.NewGuid();

    private static OpportunityDetails Details(decimal oneOff = 20_000m, decimal mrr = 5_000m, int term = 24, int? probability = null) =>
        new(Guid.NewGuid(), null, "MSP for Havbris", BusinessLine.Msp, Stage, probability, new DateOnly(2026, 11, 30), oneOff, mrr, term, null, "Referral", null);

    [Fact]
    public void Forecast_weighs_one_off_and_a_year_of_mrr_by_the_probability()
    {
        // 20 000 + 5 000 × 12 = 80 000 at 25 % = 20 000 (BR-SAL-01); the 24-month term is capped at 12.
        Opportunity.Create(Details(), stageProbability: 25, DateTimeOffset.UtcNow).Value.ForecastAmount.ShouldBe(20_000m);
        Opportunity.Forecast(0, 1_000m, 6, 50).ShouldBe(3_000m);
        Opportunity.Forecast(10_000m, 0, 0, 100).ShouldBe(10_000m);
    }

    [Fact]
    public void The_stage_sets_the_probability_unless_it_is_given()
    {
        Opportunity.Create(Details(), 25, DateTimeOffset.UtcNow).Value.Probability.ShouldBe(25);
        Opportunity.Create(Details(probability: 40), 25, DateTimeOffset.UtcNow).Value.Probability.ShouldBe(40);
    }

    [Fact]
    public void Losing_a_deal_requires_a_reason()
    {
        var opportunity = Opportunity.Create(Details(), 25, DateTimeOffset.UtcNow).Value;
        var today = new DateOnly(2026, 10, 1);
        var lostStage = Guid.NewGuid();

        opportunity.MoveTo(lostStage, 0, isWon: false, isLost: true, lostReason: null, today, DateTimeOffset.UtcNow)
            .Error!.Code.ShouldBe("SAL_LOST_REASON_REQUIRED");

        opportunity.MoveTo(lostStage, 0, false, true, "Price", today, DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();
        opportunity.Status.ShouldBe(OpportunityStatus.Lost);
        opportunity.Probability.ShouldBe(0);
        opportunity.ForecastAmount.ShouldBe(0);
        opportunity.DomainEvents.ShouldContain(e => e is OpportunityLost);
    }

    [Fact]
    public void Winning_a_deal_closes_it_at_full_probability()
    {
        var opportunity = Opportunity.Create(Details(), 50, DateTimeOffset.UtcNow).Value;

        opportunity.MoveTo(Guid.NewGuid(), 100, isWon: true, isLost: false, null, new DateOnly(2026, 10, 1), DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();

        opportunity.Status.ShouldBe(OpportunityStatus.Won);
        opportunity.ClosedOn.ShouldBe(new DateOnly(2026, 10, 1));
        opportunity.DomainEvents.ShouldContain(e => e is OpportunityWon);
        opportunity.Update(Details(), 50).Error!.Code.ShouldBe("SAL_OPPORTUNITY_CLOSED");
    }

    [Fact]
    public void A_deal_without_contact_for_a_month_is_stale()
    {
        var now = DateTimeOffset.UtcNow;
        var opportunity = Opportunity.Create(Details(), 25, now.AddDays(-45)).Value;

        opportunity.IsStale(now).ShouldBeTrue();
        opportunity.RecordActivity(now.AddDays(-2));
        opportunity.IsStale(now).ShouldBeFalse();
        // An older activity never moves the marker backwards.
        opportunity.RecordActivity(now.AddDays(-60));
        opportunity.IsStale(now).ShouldBeFalse();
    }
}

public class LeadTests
{
    private static LeadDetails Details() => new("Havbris Rørlegger AS", "923609016", "Ingrid Havbris", "INGRID@havbris.no", "900 00 001", "Web", null, null);

    [Fact]
    public void A_lead_normalizes_its_e_mail_and_starts_new()
    {
        var lead = Lead.Create(Details()).Value;

        lead.Status.ShouldBe(LeadStatus.New);
        lead.Email.ShouldBe("ingrid@havbris.no");
    }

    [Fact]
    public void Conversion_is_final_and_records_what_it_created()
    {
        var lead = Lead.Create(Details()).Value;
        var organizationId = Guid.NewGuid();
        var opportunityId = Guid.NewGuid();

        lead.Convert(organizationId, opportunityId, DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();

        lead.Status.ShouldBe(LeadStatus.Converted);
        lead.OrganizationId.ShouldBe(organizationId);
        lead.OpportunityId.ShouldBe(opportunityId);
        lead.DomainEvents.ShouldContain(e => e is LeadConverted);
        lead.Convert(organizationId, null, DateTimeOffset.UtcNow).Error!.Code.ShouldBe("SAL_LEAD_CONVERTED");
        lead.Update(Details()).Error!.Code.ShouldBe("SAL_LEAD_CONVERTED");
    }

    [Fact]
    public void Disqualifying_needs_a_reason_and_can_be_undone_by_qualifying()
    {
        var lead = Lead.Create(Details()).Value;

        lead.Disqualify("  ", DateTimeOffset.UtcNow).Error!.Code.ShouldBe("SAL_REASON_REQUIRED");
        lead.Disqualify("No budget", DateTimeOffset.UtcNow).IsSuccess.ShouldBeTrue();
        lead.Status.ShouldBe(LeadStatus.Disqualified);
        lead.Qualify().IsSuccess.ShouldBeTrue();
        lead.Status.ShouldBe(LeadStatus.Qualified);
        lead.DisqualifyReason.ShouldBeNull();
    }
}

public class ActivityTests
{
    private static ActivityDetails Details(ActivityType type) =>
        new(type, Guid.NewGuid(), null, null, null, "Ring kunden", "Om fornyelse", DateTimeOffset.UtcNow.AddDays(1), ActivityPriority.Normal, Guid.NewGuid());

    [Fact]
    public void Notes_and_calls_are_logged_as_done_while_tasks_stay_open()
    {
        var now = DateTimeOffset.UtcNow;

        Activity.Create(Details(ActivityType.Note), now).Value.Status.ShouldBe(ActivityStatus.Done);
        Activity.Create(Details(ActivityType.Call), now).Value.Status.ShouldBe(ActivityStatus.Done);
        Activity.Create(Details(ActivityType.Task), now).Value.Status.ShouldBe(ActivityStatus.Open);
        Activity.Create(Details(ActivityType.Meeting), now).Value.DueAt.ShouldNotBeNull();
    }

    [Fact]
    public void Every_activity_tells_the_deal_that_something_happened()
    {
        var activity = Activity.Create(Details(ActivityType.Task), DateTimeOffset.UtcNow).Value;

        activity.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<ActivityLogged>();
    }

    [Fact]
    public void An_overdue_task_is_flagged_until_it_is_completed()
    {
        var now = DateTimeOffset.UtcNow;
        var activity = Activity.Create(Details(ActivityType.Task) with { DueAt = now.AddDays(-1) }, now).Value;

        activity.IsOverdue(now).ShouldBeTrue();
        activity.Complete(Guid.NewGuid(), now).IsSuccess.ShouldBeTrue();
        activity.IsOverdue(now).ShouldBeFalse();
        activity.Status.ShouldBe(ActivityStatus.Done);
    }
}

public class CspSubscriptionTests
{
    private static readonly TimeSpan Window = TimeSpan.FromHours(168);

    private static ExternalSubscription Source(int quantity = 25, DateTimeOffset? purchasedAt = null) => new(
        SubscriptionSource.PartnerCenter, "csp-1", "Havbris AS", "tenant-1", "923609016", "sub-1", "CFQ7TTC0LF8Q", "Microsoft 365 Business Premium",
        "sku-1", quantity, SubscriptionStatus.Active, SubscriptionTerm.P1Y, SubscriptionBillingCycle.Annual,
        new DateOnly(2026, 9, 1), new DateOnly(2027, 8, 31), new DateOnly(2027, 8, 31), true, purchasedAt, 225m);

    [Fact]
    public void A_new_subscription_gets_the_seven_day_cancellation_window_from_its_purchase()
    {
        var purchased = new DateTimeOffset(2026, 9, 15, 10, 0, 0, TimeSpan.Zero);
        var now = purchased.AddHours(2);

        var subscription = CspSubscription.From(Source(purchasedAt: purchased), Window, now);

        subscription.CancellationWindowEndsAt.ShouldBe(purchased.AddHours(168));
        subscription.IsCancellationWindowOpen(now).ShouldBeTrue();
        subscription.IsCancellationWindowOpen(purchased.AddHours(169)).ShouldBeFalse();
    }

    [Fact]
    public void Buying_more_licences_opens_a_new_window()
    {
        var purchased = new DateTimeOffset(2026, 9, 1, 8, 0, 0, TimeSpan.Zero);
        var subscription = CspSubscription.From(Source(purchasedAt: purchased), Window, purchased);
        var increasedAt = purchased.AddDays(30);

        subscription.Apply(Source(quantity: 30), increasedAt, Window).ShouldBeTrue();

        subscription.Quantity.ShouldBe(30);
        subscription.QuantityIncreasedAt.ShouldBe(increasedAt);
        subscription.CancellationWindowEndsAt.ShouldBe(increasedAt.AddHours(168));

        // Reducing the quantity does not reopen it.
        var reducedAt = increasedAt.AddDays(1);
        subscription.Apply(Source(quantity: 28), reducedAt, Window);
        subscription.CancellationWindowEndsAt.ShouldBe(increasedAt.AddHours(168));
    }

    [Fact]
    public void Unchanged_subscriptions_report_no_change()
    {
        var now = DateTimeOffset.UtcNow;
        var subscription = CspSubscription.From(Source(), Window, now);

        subscription.Apply(Source(), now.AddHours(1), Window).ShouldBeFalse();
        subscription.Apply(Source() with { Status = SubscriptionStatus.Suspended }, now.AddHours(2), Window).ShouldBeTrue();
    }

    [Theory]
    [InlineData("2027-07-05", 60, true)]
    [InlineData("2027-06-01", 60, false)]
    [InlineData("2027-09-01", 60, false)]
    public void Renewal_warning_looks_a_number_of_days_ahead(string today, int days, bool expected) =>
        CspSubscription.From(Source(), Window, DateTimeOffset.UtcNow)
            .IsRenewingWithin(DateOnly.Parse(today, System.Globalization.CultureInfo.InvariantCulture), days).ShouldBe(expected);
}

public class SubscriptionCsvTests
{
    [Fact]
    public void A_distributor_export_is_read_with_semicolons_and_norwegian_headers()
    {
        var csv = string.Join('\n',
            "Kundenavn;Organisasjonsnummer;KundeID;AbonnementsID;OfferId;Produktnavn;Antall;Status;Bindingstid;Faktureringsperiode;Startdato;Sluttdato;Autofornyelse;Partnerpris",
            "Havbris AS;923 609 016;csp-100;sub-100;CFQ7TTC0LF8Q;Microsoft 365 Business Premium;25;Active;P1Y;Annual;01.09.2026;31.08.2027;ja;225,50",
            "Nordkapp AS;;csp-101;sub-101;CFQ7TTC0LH18;Microsoft 365 E3;10;Suspended;P1M;Monthly;2026-09-01;2026-09-30;nei;312.00");

        var result = SubscriptionCsv.Parse(csv);

        result.Errors.ShouldBeEmpty();
        result.Subscriptions.Count.ShouldBe(2);
        var first = result.Subscriptions[0];
        first.Source.ShouldBe(SubscriptionSource.Distributor);
        first.CspCustomerId.ShouldBe("csp-100");
        first.OrganizationNumber.ShouldBe("923609016");
        first.Quantity.ShouldBe(25);
        first.Term.ShouldBe(SubscriptionTerm.P1Y);
        first.BillingCycle.ShouldBe(SubscriptionBillingCycle.Annual);
        first.StartDate.ShouldBe(new DateOnly(2026, 9, 1));
        first.AutoRenew.ShouldBeTrue();
        first.PartnerUnitPrice.ShouldBe(225.50m);
        result.Subscriptions[1].Status.ShouldBe(SubscriptionStatus.Suspended);
        result.Subscriptions[1].OrganizationNumber.ShouldBeNull();
        result.Subscriptions[1].AutoRenew.ShouldBeFalse();
    }

    [Fact]
    public void Fully_norwegian_headers_are_recognised()
    {
        var result = SubscriptionCsv.Parse(string.Join('\n',
            "Kunde;KundeID;AbonnementsID;Produktid;Antall",
            "Havbris AS;csp-100;sub-100;CFQ7TTC0LF8Q;7"));

        result.Errors.ShouldBeEmpty();
        result.UnknownColumns.ShouldBeEmpty();
        var subscription = result.Subscriptions.ShouldHaveSingleItem();
        subscription.CspCustomerName.ShouldBe("Havbris AS");
        subscription.OfferId.ShouldBe("CFQ7TTC0LF8Q");
        subscription.Quantity.ShouldBe(7);
    }

    [Fact]
    public void Commas_quotes_and_unknown_columns_are_handled()
    {
        var csv = string.Join('\n',
            "customerId,subscriptionId,offerId,quantity,offerName,someExtraColumn",
            "csp-1,sub-1,OFFER-1,3,\"Office, small business\",whatever");

        var result = SubscriptionCsv.Parse(csv);

        result.Subscriptions.ShouldHaveSingleItem().OfferName.ShouldBe("Office, small business");
        result.UnknownColumns.ShouldBe(["someExtraColumn"]);
    }

    [Fact]
    public void Missing_columns_and_bad_rows_are_reported_instead_of_guessed()
    {
        SubscriptionCsv.Parse("customerId;offerId\ncsp-1;OFFER-1").Errors.ShouldContain(e => e.Contains("subscriptionid", StringComparison.Ordinal));

        var badQuantity = SubscriptionCsv.Parse(string.Join('\n',
            "customerId;subscriptionId;offerId;quantity",
            "csp-1;sub-1;OFFER-1;many",
            "csp-2;sub-2;OFFER-2;4"));
        badQuantity.Subscriptions.ShouldHaveSingleItem().SubscriptionId.ShouldBe("sub-2");
        badQuantity.Errors.ShouldHaveSingleItem().ShouldContain("Row 2");
    }
}

public class MsBillingCsvTests
{
    [Fact]
    public void A_distributor_invoice_file_becomes_billed_lines()
    {
        var csv = string.Join('\n',
            "CustomerId;Kundenavn;SubscriptionId;OfferId;Produktnavn;Antall;Enhetspris;Beløp;Valuta;Fakturanummer;ChargeStartDate;ChargeEndDate",
            "csp-100;Havbris AS;sub-100;CFQ7TTC0LF8Q;Microsoft 365 Business Premium;25;180,50;4 512,50;NOK;G012345;01.08.2026;31.08.2026",
            "csp-101;Nordkapp AS;sub-101;CFQ7TTC0LH18;Microsoft 365 E3;10;312.00;3120.00;NOK;G012345;2026-08-01;2026-08-31");

        var result = MsBillingCsv.Parse(csv, new DateOnly(2026, 8, 1));

        result.Errors.ShouldBeEmpty();
        result.Lines.Count.ShouldBe(2);
        var first = result.Lines[0];
        first.Source.ShouldBe(MsBillingSource.Csv);
        first.CspCustomerId.ShouldBe("csp-100");
        first.Quantity.ShouldBe(25m);
        first.UnitPrice.ShouldBe(180.50m);
        first.Total.ShouldBe(4512.50m);
        first.PeriodStart.ShouldBe(new DateOnly(2026, 8, 1));
        first.PeriodEnd.ShouldBe(new DateOnly(2026, 8, 31));
        first.InvoiceId.ShouldBe("G012345");
    }

    [Fact]
    public void A_file_without_a_period_is_read_as_the_month_that_is_being_reconciled()
    {
        var result = MsBillingCsv.Parse(
            string.Join('\n', "customerId,offerId,total", "csp-1,OFFER-1,1000"), new DateOnly(2026, 7, 1));

        var line = result.Lines.ShouldHaveSingleItem();
        line.PeriodStart.ShouldBe(new DateOnly(2026, 7, 1));
        line.PeriodEnd.ShouldBe(new DateOnly(2026, 7, 31));
        // Without a quantity there is nothing to divide by, so the unit price stays at zero instead of guessing.
        line.UnitPrice.ShouldBe(0m);
    }

    [Fact]
    public void Missing_columns_and_bad_amounts_are_reported()
    {
        MsBillingCsv.Parse("customerId;offerId\ncsp-1;OFFER-1", new DateOnly(2026, 8, 1))
            .Errors.ShouldContain(e => e.Contains("total", StringComparison.Ordinal));

        var result = MsBillingCsv.Parse(
            string.Join('\n', "customerId;offerId;total", "csp-1;OFFER-1;lots", "csp-2;OFFER-2;12"), new DateOnly(2026, 8, 1));
        result.Lines.ShouldHaveSingleItem().Total.ShouldBe(12m);
        result.Errors.ShouldHaveSingleItem().ShouldContain("Row 2");
    }

    [Fact]
    public void The_line_key_identifies_the_same_charge_across_imports()
    {
        var line = new ExternalBilledLine(
            MsBillingSource.Csv, new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31), "G012345", "csp-1", "Havbris AS",
            "sub-1", "OFFER-1", "Business Premium", 25m, 180.5m, 4512.5m, "NOK");

        MsBilledLine.KeyOf(line).ShouldBe(MsBilledLine.KeyOf(line with { Quantity = 30m, Total = 5415m }));
        MsBilledLine.KeyOf(line).ShouldNotBe(MsBilledLine.KeyOf(line with { PeriodStart = new DateOnly(2026, 9, 1) }));
    }
}

public class LicenseSnapshotTests
{
    [Fact]
    public void Unused_is_what_is_paid_for_but_not_handed_out()
    {
        var snapshot = LicenseSnapshot.Create(
            new LicenseUsageReading(Guid.NewGuid(), "sku-1", "SPB", 25, 21), new DateOnly(2026, 9, 22), DateTimeOffset.UtcNow);

        snapshot.Unused.ShouldBe(4);

        // A tenant that assigns more than it bought (a trial on top) never shows a negative number.
        snapshot.Update(new LicenseUsageReading(snapshot.OrganizationId, "sku-1", "SPB", 25, 30), DateTimeOffset.UtcNow);
        snapshot.Assigned.ShouldBe(30);
        snapshot.Unused.ShouldBe(0);
    }
}
