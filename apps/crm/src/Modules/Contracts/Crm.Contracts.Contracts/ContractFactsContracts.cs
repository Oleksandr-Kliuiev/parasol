namespace Crm.Contracts.Contracts;

/// <summary>
/// An organization's active contracts as its contract tab lists them (<c>GET /api/v1/contracts?organizationId=…&amp;status=Active</c>):
/// how many, and the earliest end date among them (null when none has one).
/// </summary>
public sealed record OrganizationAgreementFacts(Guid OrganizationId, int Active, DateOnly? NextEnd);

/// <summary>
/// An organization's active hour banks as the hour-bank list shows them without closed ones: how many, their remaining and
/// purchased hours summed, and whether any of them is low (the bank's <c>isLow</c>).
/// </summary>
public sealed record OrganizationHourBankFacts(Guid OrganizationId, int Active, decimal RemainingHours, decimal PurchasedHours, bool Low);

/// <summary>An organization with an active contract that ends inside a window: the soonest such end date and how many end in it.</summary>
public sealed record OrganizationAgreementEnding(Guid OrganizationId, DateOnly EndsOn, int Contracts);

/// <summary>An organization with at least one low active hour bank, and how many it has.</summary>
public sealed record OrganizationLowHourBanks(Guid OrganizationId, int Banks);

/// <summary>
/// What the contracts module can tell about organizations for the customer list (UX 2026, В6). Every call is one SQL aggregate
/// grouped by organization, never a query per organization.
/// </summary>
public interface IContractFacts
{
    /// <summary>Active contracts of the given organizations (a page of the customer list); organizations without one are absent.</summary>
    Task<IReadOnlyList<OrganizationAgreementFacts>> GetAgreementsAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken);

    /// <summary>Active hour banks of the given organizations (a page of the customer list); organizations without one are absent.</summary>
    Task<IReadOnlyList<OrganizationHourBankFacts>> GetHourBanksAsync(IReadOnlyCollection<Guid> organizationIds, CancellationToken cancellationToken);

    /// <summary>Every organization with an active contract whose end date is between <paramref name="from"/> and <paramref name="to"/>, both included.</summary>
    Task<IReadOnlyList<OrganizationAgreementEnding>> GetAgreementsEndingAsync(DateOnly from, DateOnly to, CancellationToken cancellationToken);

    /// <summary>Every organization with at least one low active hour bank.</summary>
    Task<IReadOnlyList<OrganizationLowHourBanks>> GetLowHourBanksAsync(CancellationToken cancellationToken);
}
