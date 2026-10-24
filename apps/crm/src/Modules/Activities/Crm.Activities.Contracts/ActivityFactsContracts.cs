namespace Crm.Activities.Contracts;

/// <summary>
/// The open work of one organization as its activity timeline shows it: <paramref name="Open"/> is what
/// <c>GET /api/v1/activities?organizationId=…&amp;open=true</c> counts, <paramref name="Overdue"/> how many of those items are past
/// their due time — the items the timeline marks overdue.
/// </summary>
public sealed record OrganizationWorkFacts(Guid OrganizationId, int Open, int Overdue);

/// <summary>An organization with open work past its due time, and how many such items it has.</summary>
public sealed record OrganizationOverdueWork(Guid OrganizationId, int Overdue);

/// <summary>
/// What the activities module can tell about organizations for the customer list (UX 2026, В6). Every call is one SQL aggregate
/// grouped by organization, never a query per organization.
/// </summary>
public interface IActivityFacts
{
    /// <summary>
    /// The open work of the given organizations (a page of the customer list, not every organization at once); an organization
    /// without open work is absent from the answer.
    /// </summary>
    Task<IReadOnlyList<OrganizationWorkFacts>> GetWorkAsync(
        IReadOnlyCollection<Guid> organizationIds, DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Every organization with open work past its due time at <paramref name="now"/>.</summary>
    Task<IReadOnlyList<OrganizationOverdueWork>> GetOverdueWorkAsync(DateTimeOffset now, CancellationToken cancellationToken);
}
