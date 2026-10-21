using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;

namespace Crm.Web.CustomerFacts;

/// <summary>Open work as the activity tab lists it (<c>open=true</c>), and how much of it is past its due time.</summary>
public sealed record WorkFactsDto(int Open, int Overdue);

/// <summary>Active contracts as the contract tab lists them (<c>status=Active</c>) and the earliest end date among them.</summary>
public sealed record AgreementFactsDto(int Active, DateOnly? NextEnd);

/// <summary>Active hour banks: hours are not money, so every holder of <c>contracts.read</c> sees them, as on the hour-bank list.</summary>
public sealed record HourBankFactsDto(int Active, decimal RemainingHours, decimal PurchasedHours, bool Low);

/// <summary>Open invoices as the invoice tab counts them; the amounts are removed for roles without <c>finance.read</c>, as there.</summary>
public sealed record InvoiceFactsDto(
    int Open,
    int Overdue,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? Outstanding,
    [property: SensitiveData(Permissions.FinanceRead)] decimal? OverdueAmount);

/// <summary>The facts of one organization. A part is null when the caller may not see that kind of record at all.</summary>
public sealed record CustomerFactsDto(WorkFactsDto? Work, AgreementFactsDto? Agreements, HourBankFactsDto? HourBanks, InvoiceFactsDto? Invoices);

/// <summary>The facts of one requested organization, in the order the ids were sent.</summary>
public sealed record CustomerFactsItem(
    Guid OrganizationId, WorkFactsDto? Work, AgreementFactsDto? Agreements, HourBankFactsDto? HourBanks, InvoiceFactsDto? Invoices);

/// <summary><paramref name="AsOf"/> is the day (Europe/Oslo) that "overdue" and "ending" were measured against.</summary>
public sealed record CustomerFactsResponse(DateOnly AsOf, IReadOnlyList<CustomerFactsItem> Items);

public sealed record AttentionUserDto(Guid Id, string DisplayName);

public sealed record AttentionOrganizationDto(Guid Id, string Name, OrganizationStatus Status, AttentionUserDto? AccountManager);

/// <summary>One customer that needs attention: why (most urgent first) and the same facts the customer list shows for it.</summary>
public sealed record AttentionItem(AttentionOrganizationDto Organization, IReadOnlyList<AttentionReason> Reasons, CustomerFactsDto Facts);

/// <summary>The most urgent customers first; <paramref name="Total"/> counts every customer that qualifies, not only the ones shown.</summary>
public sealed record AttentionResponse(DateOnly AsOf, int Total, IReadOnlyList<AttentionItem> Items);

/// <summary>
/// The modules' answers for a set of organizations, turned into response parts. A part the caller may not see stays null; an
/// organization a module said nothing about has zeros in that part (nothing open), never a missing part.
/// </summary>
internal sealed class CustomerFactsSet(
    IReadOnlyList<OrganizationWorkFacts>? work,
    IReadOnlyList<OrganizationAgreementFacts>? agreements,
    IReadOnlyList<OrganizationHourBankFacts>? hourBanks,
    IReadOnlyList<OrganizationInvoiceFacts>? invoices,
    bool showMoney)
{
    private readonly Dictionary<Guid, OrganizationWorkFacts>? _work = work?.ToDictionary(f => f.OrganizationId);
    private readonly Dictionary<Guid, OrganizationAgreementFacts>? _agreements = agreements?.ToDictionary(f => f.OrganizationId);
    private readonly Dictionary<Guid, OrganizationHourBankFacts>? _hourBanks = hourBanks?.ToDictionary(f => f.OrganizationId);
    private readonly Dictionary<Guid, OrganizationInvoiceFacts>? _invoices = invoices?.ToDictionary(f => f.OrganizationId);

    public CustomerFactsDto For(Guid organizationId) => new(Work(organizationId), Agreements(organizationId), HourBanks(organizationId), Invoices(organizationId));

    public CustomerFactsItem Item(Guid organizationId) =>
        new(organizationId, Work(organizationId), Agreements(organizationId), HourBanks(organizationId), Invoices(organizationId));

    private WorkFactsDto? Work(Guid id) =>
        _work is null ? null : _work.TryGetValue(id, out var w) ? new WorkFactsDto(w.Open, w.Overdue) : new WorkFactsDto(0, 0);

    private AgreementFactsDto? Agreements(Guid id) =>
        _agreements is null ? null : _agreements.TryGetValue(id, out var a) ? new AgreementFactsDto(a.Active, a.NextEnd) : new AgreementFactsDto(0, null);

    private HourBankFactsDto? HourBanks(Guid id) =>
        _hourBanks is null ? null
        : _hourBanks.TryGetValue(id, out var b) ? new HourBankFactsDto(b.Active, b.RemainingHours, b.PurchasedHours, b.Low)
        : new HourBankFactsDto(0, 0m, 0m, false);

    // [SensitiveData] removes the amounts from the response of a caller without finance.read; they are not even handed over.
    private InvoiceFactsDto? Invoices(Guid id) =>
        _invoices is null ? null
        : _invoices.TryGetValue(id, out var i)
            ? new InvoiceFactsDto(i.Open, i.Overdue, showMoney ? i.Outstanding : null, showMoney ? i.OverdueAmount : null)
            : new InvoiceFactsDto(0, 0, showMoney ? 0m : null, showMoney ? 0m : null);
}
