using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Application;

namespace Crm.Web.CustomerFacts;

/// <summary>
/// "Whom do I attend to" on the customer list (UX 2026, В6), composed from the modules' contracts like global search: each module
/// answers with one SQL aggregate grouped by organization, using the filters of the list behind the matching customer-card tab,
/// so a number here is the number the card shows. A part is asked for only when the caller holds its permission
/// (<c>activities.read</c>, <c>contracts.read</c>, <c>billing.read</c>); invoice amounts additionally need <c>finance.read</c>.
/// None of these lists has a record scope, so neither has this. Modules are asked one after the other: they share the request.
/// </summary>
internal sealed class CustomerFactsService(
    IActivityFacts activities,
    IContractFacts contracts,
    IInvoiceFacts invoices,
    ICustomersApi customers,
    IUserDirectory users,
    ICurrentUser user,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<CustomerFactsResponse> GetFactsAsync(IReadOnlyList<Guid> organizationIds, CancellationToken ct)
    {
        var clock = Clock.Now(time);
        var facts = await LoadAsync(organizationIds, clock, ct);
        return new CustomerFactsResponse(clock.Today, organizationIds.Select(facts.Item).ToList());
    }

    /// <summary>
    /// The customers with at least one reason the caller may see, most urgent first (<see cref="AttentionRanking.Rank{T}"/>): the
    /// first <see cref="AttentionRanking.Shown"/> with their facts and the number of all of them. Deleted organizations are left out;
    /// <paramref name="mine"/> keeps the customers whose account manager is the caller.
    /// </summary>
    public async Task<AttentionResponse> GetAttentionAsync(bool mine, CancellationToken ct)
    {
        var clock = Clock.Now(time);
        var access = Access.Of(user);
        var candidates = AttentionRanking.Merge(
            access.Invoices ? await invoices.GetOverdueInvoicesAsync(clock.Today, ct) : [],
            access.Work ? await activities.GetOverdueWorkAsync(clock.Instant, ct) : [],
            access.Contracts ? await contracts.GetAgreementsEndingAsync(clock.Today, clock.Today.AddDays(AttentionRanking.AgreementEndingDays), ct) : [],
            access.Contracts ? await contracts.GetLowHourBanksAsync(ct) : []);

        var organizations = await customers.GetOrganizationsAsync(candidates.Select(c => c.OrganizationId).ToList(), ct);
        var me = user.UserId;
        var ranked = AttentionRanking.Rank(
            candidates.Where(c => organizations.TryGetValue(c.OrganizationId, out var organization) &&
                                  (!mine || (me is not null && organization.AccountManagerId == me))),
            c => c,
            c => organizations[c.OrganizationId].Name,
            byOverdueAmount: access.Money);
        var shown = ranked.Take(AttentionRanking.Shown).ToList();

        var facts = await LoadAsync(shown.Select(c => c.OrganizationId).ToList(), clock, ct);
        var managers = await users.GetUsersAsync(
            shown.Select(c => organizations[c.OrganizationId].AccountManagerId).OfType<Guid>().Distinct().ToList(), ct);

        return new AttentionResponse(
            clock.Today,
            ranked.Count,
            shown.Select(c =>
            {
                var organization = organizations[c.OrganizationId];
                var manager = organization.AccountManagerId is { } id && managers.TryGetValue(id, out var found)
                    ? new AttentionUserDto(found.Id, found.DisplayName)
                    : null;
                return new AttentionItem(
                    new AttentionOrganizationDto(organization.Id, organization.Name, organization.Status, manager),
                    c.Reasons,
                    facts.For(c.OrganizationId));
            }).ToList());
    }

    // An empty page asks no module anything: each of them answers an empty batch without a query.
    private async Task<CustomerFactsSet> LoadAsync(IReadOnlyList<Guid> organizationIds, Clock clock, CancellationToken ct)
    {
        var access = Access.Of(user);
        return new CustomerFactsSet(
            access.Work ? await activities.GetWorkAsync(organizationIds, clock.Instant, ct) : null,
            access.Contracts ? await contracts.GetAgreementsAsync(organizationIds, ct) : null,
            access.Contracts ? await contracts.GetHourBanksAsync(organizationIds, ct) : null,
            access.Invoices ? await invoices.GetOpenInvoicesAsync(organizationIds, clock.Today, ct) : null,
            access.Money);
    }

    /// <summary>One instant per request: "overdue work" is measured against it, everything dated against its day in Europe/Oslo.</summary>
    private readonly record struct Clock(DateTimeOffset Instant, DateOnly Today)
    {
        public static Clock Now(TimeProvider time)
        {
            var now = time.GetUtcNow();
            return new Clock(now, DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, Oslo).DateTime));
        }
    }

    private readonly record struct Access(bool Work, bool Contracts, bool Invoices, bool Money)
    {
        public static Access Of(ICurrentUser user) => new(
            user.HasPermission(Permissions.ActivitiesRead),
            user.HasPermission(Permissions.ContractsRead),
            user.HasPermission(Permissions.BillingRead),
            user.HasPermission(Permissions.FinanceRead));
    }
}
