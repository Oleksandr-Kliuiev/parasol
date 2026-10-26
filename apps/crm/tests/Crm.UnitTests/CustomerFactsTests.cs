using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Contracts.Domain;
using Crm.Contracts.Features;
using Crm.Web.CustomerFacts;

namespace Crm.UnitTests;

/// <summary>
/// UX 2026, В6: how the customer list merges the modules' answers, orders the customers that need attention, reads the ids of a
/// facts request and hides money. The crm-web sources are linked into this project (see the project file).
/// </summary>
public class CustomerFactsTests
{
    private static readonly DateOnly Today = new(2026, 10, 21);

    [Fact]
    public void Merge_keeps_one_candidate_per_organization_with_everything_the_modules_said()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid(), c = Guid.NewGuid();

        var merged = AttentionRanking.Merge(
            [new OrganizationOverdueInvoices(a, 2, 1_500m), new OrganizationOverdueInvoices(c, 0, 0m)],
            [new OrganizationOverdueWork(a, 3), new OrganizationOverdueWork(b, 1)],
            [new OrganizationAgreementEnding(b, Today.AddDays(9), 1), new OrganizationAgreementEnding(b, Today.AddDays(4), 2)],
            [new OrganizationLowHourBanks(a, 1), new OrganizationLowHourBanks(c, 0)]);

        // A row without anything overdue or low is no reason; the soonest ending wins.
        merged.OrderBy(x => x.OrganizationId).ShouldBe(new[]
        {
            new AttentionCandidate(a, 2, 1_500m, 3, null, true),
            new AttentionCandidate(b, 0, 0m, 1, Today.AddDays(4), false),
        }.OrderBy(x => x.OrganizationId));
        merged.Single(x => x.OrganizationId == a).Reasons.ShouldBe([AttentionReason.OverdueInvoices, AttentionReason.OverdueWork, AttentionReason.HourBankLow]);
        merged.Single(x => x.OrganizationId == b).Reasons.ShouldBe([AttentionReason.OverdueWork, AttentionReason.AgreementEnding]);
    }

    [Fact]
    public void Rank_orders_overdue_invoices_by_amount_then_work_then_the_soonest_ending_then_low_banks_then_name_and_id()
    {
        var (bigAmount, manyInvoices, moreWork, workAndLow, work, endsSoon, endsLater, lowAlfa, lowBeta) = Candidates();

        var ranked = AttentionRanking.Rank(
            [lowBeta, endsLater, work, lowAlfa, workAndLow, manyInvoices, endsSoon, moreWork, bigAmount], x => x.Candidate, x => x.Name, byOverdueAmount: true);

        ranked.Select(x => x.Name).ShouldBe([
            bigAmount.Name, manyInvoices.Name, moreWork.Name, workAndLow.Name, work.Name, endsSoon.Name, endsLater.Name, lowAlfa.Name, lowBeta.Name,
        ]);
    }

    [Fact]
    public void Rank_without_money_orders_overdue_invoices_by_how_many_are_overdue()
    {
        var (bigAmount, manyInvoices, _, _, _, _, _, _, _) = Candidates();

        AttentionRanking.Rank([bigAmount, manyInvoices], x => x.Candidate, x => x.Name, byOverdueAmount: false)
            .Select(x => x.Name).ShouldBe([manyInvoices.Name, bigAmount.Name]);
        AttentionRanking.Rank([manyInvoices, bigAmount], x => x.Candidate, x => x.Name, byOverdueAmount: true)
            .Select(x => x.Name).ShouldBe([bigAmount.Name, manyInvoices.Name]);
    }

    [Fact]
    public void Equal_candidates_go_by_name_in_norwegian_order_ignoring_case_then_by_id()
    {
        Guid first = new("00000000-0000-0000-0000-000000000001"), second = new("00000000-0000-0000-0000-000000000002");
        Named Low(Guid id, string name) => new(new AttentionCandidate(id, 0, 0m, 0, null, true), name);

        AttentionRanking.Rank([Low(first, "Åsen AS"), Low(first, "Ørje AS"), Low(first, "Zeta AS"), Low(first, "Æra AS"), Low(first, "alfa AS")],
                x => x.Candidate, x => x.Name, byOverdueAmount: true)
            .Select(x => x.Name).ShouldBe(["alfa AS", "Zeta AS", "Æra AS", "Ørje AS", "Åsen AS"]);
        AttentionRanking.Rank([Low(second, "Lik AS"), Low(first, "lik AS")], x => x.Candidate, x => x.Name, byOverdueAmount: true)
            .Select(x => x.Candidate.OrganizationId).ShouldBe([first, second]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("not-a-guid")]
    [InlineData("8d3c8e1e-7b8a-4f53-9a37-3f0e4f6b2d10,")]
    [InlineData("8d3c8e1e-7b8a-4f53-9a37-3f0e4f6b2d10,8d3c8e1e-7b8a-4f53-9a37-3f0e4f6b2d10")]
    [InlineData("8d3c8e1e-7b8a-4f53-9a37-3f0e4f6b2d10;5f0f7f3e-8e2a-4b8a-8f1c-1c2d3e4f5a6b")]
    public void Facts_ids_that_are_not_one_to_fifty_different_ids_are_refused(string? ids) =>
        CustomerFactsRequest.ParseIds(ids).ShouldBeNull();

    [Fact]
    public void Facts_ids_keep_the_order_they_were_sent_in_and_fifty_is_the_most()
    {
        var ids = Enumerable.Range(0, 51).Select(_ => Guid.NewGuid()).ToList();

        CustomerFactsRequest.ParseIds($"{ids[1]}, {ids[0]} ").ShouldBe([ids[1], ids[0]]);
        CustomerFactsRequest.ParseIds(string.Join(',', ids.Take(50))).ShouldBe(ids.Take(50));
        CustomerFactsRequest.ParseIds(string.Join(',', ids)).ShouldBeNull();
    }

    [Fact]
    public void A_part_the_caller_may_not_see_is_null_and_an_organization_without_rows_has_zeros()
    {
        Guid known = Guid.NewGuid(), unknown = Guid.NewGuid();
        var set = new CustomerFactsSet(
            [new OrganizationWorkFacts(known, 3, 1)],
            [new OrganizationAgreementFacts(known, 2, Today.AddDays(30))],
            [new OrganizationHourBankFacts(known, 1, 6m, 40m, true)],
            null,
            showMoney: true);

        set.For(known).ShouldBe(new CustomerFactsDto(
            new WorkFactsDto(3, 1), new AgreementFactsDto(2, Today.AddDays(30)), new HourBankFactsDto(1, 6m, 40m, true), null));
        set.For(unknown).ShouldBe(new CustomerFactsDto(
            new WorkFactsDto(0, 0), new AgreementFactsDto(0, null), new HourBankFactsDto(0, 0m, 0m, false), null));
        set.Item(known).ShouldBe(new CustomerFactsItem(
            known, new WorkFactsDto(3, 1), new AgreementFactsDto(2, Today.AddDays(30)), new HourBankFactsDto(1, 6m, 40m, true), null));
    }

    [Fact]
    public void Invoice_amounts_are_neither_handed_over_nor_serialized_without_finance_read()
    {
        var id = Guid.NewGuid();
        IReadOnlyList<OrganizationInvoiceFacts> invoices = [new(id, 2, 12_500m, 1, 2_500m)];
        new CustomerFactsSet(null, null, null, invoices, showMoney: true).For(id).Invoices.ShouldBe(new InvoiceFactsDto(2, 1, 12_500m, 2_500m));
        new CustomerFactsSet(null, null, null, invoices, showMoney: false).For(id).Invoices.ShouldBe(new InvoiceFactsDto(2, 1, null, null));
        new CustomerFactsSet(null, null, null, [], showMoney: false).For(id).Invoices.ShouldBe(new InvoiceFactsDto(0, 0, null, null));

        // The response hides them the way it hides every [SensitiveData] amount: the property is not there at all.
        static string Json(InvoiceFactsDto dto, bool finance) => JsonSerializer.Serialize(dto, new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            TypeInfoResolver = new DefaultJsonTypeInfoResolver().WithAddedModifier(SensitiveDataJsonModifier.Create(p => finance && p == Permissions.FinanceRead)),
        });
        Json(new InvoiceFactsDto(2, 1, 12_500m, 2_500m), finance: true).ShouldBe("""{"open":2,"overdue":1,"outstanding":12500,"overdueAmount":2500}""");
        Json(new InvoiceFactsDto(2, 1, 12_500m, 2_500m), finance: false).ShouldBe("""{"open":2,"overdue":1}""");
    }

    [Theory]
    [InlineData(40.0, 34.0, 20.0)]
    [InlineData(10.0, 8.0, 20.0)]
    [InlineData(10.0, 8.5, 20.0)]
    [InlineData(10.0, 12.0, 20.0)]
    [InlineData(10.0, 0.0, 20.0)]
    [InlineData(10.0, 5.0, 50.0)]
    [InlineData(10.0, 5.01, 50.0)]
    [InlineData(7.5, 7.5, 0.0)]
    [InlineData(33.33, 27.5, 17.5)]
    public void The_sql_balance_of_an_hour_bank_is_the_balance_the_bank_shows(double hours, double used, double lowBalancePct)
    {
        var bank = HourBank.Create(Guid.NewGuid(), null, "Klippekort", (decimal)hours, Today, null, null, (decimal)lowBalancePct).Value.Bank;
        if (used > 0)
        {
            bank.Consume((decimal)used, Today, null, null, null, DateTimeOffset.UnixEpoch).IsSuccess.ShouldBeTrue();
        }

        var row = ContractFacts.Balance.Compile()(bank);

        (row.OrganizationId, row.PurchasedHours, row.RemainingHours, row.IsLow).ShouldBe((bank.OrganizationId, bank.PurchasedHours, bank.RemainingHours, bank.IsLow));
    }

    private sealed record Named(AttentionCandidate Candidate, string Name);

    private static (Named BigAmount, Named ManyInvoices, Named MoreWork, Named WorkAndLow, Named Work, Named EndsSoon, Named EndsLater, Named LowAlfa,
        Named LowBeta) Candidates()
    {
        Named Of(string name, int invoices = 0, decimal amount = 0m, int work = 0, DateOnly? ends = null, bool low = false) =>
            new(new AttentionCandidate(Guid.NewGuid(), invoices, amount, work, ends, low), name);

        return (
            Of("Stor AS", invoices: 1, amount: 9_000m, ends: Today.AddDays(5)),
            Of("Mange AS", invoices: 3, amount: 300m),
            Of("Travel AS", work: 2),
            Of("Oppgave og lite AS", work: 1, low: true),
            Of("Oppgave AS", work: 1),
            Of("Snart AS", ends: Today),
            Of("Senere AS", ends: Today.AddDays(60)),
            Of("alfa AS", low: true),
            Of("Beta AS", low: true));
    }
}
