namespace Crm.Security.Contracts;

/// <summary>
/// A stored summary report of a security source (M41) as other parts of the CRM read it (M43): its customer (and the source's
/// organization it was read under), period, figures and the source's link to its PDF.
/// </summary>
public sealed record SummaryReportView(
    string System,
    long ExternalId,
    Guid OrganizationId,
    long ExternalOrganizationId,
    string Type,
    DateOnly? PeriodStart,
    DateOnly? PeriodEnd,
    string? Url,
    int? AgentsCount,
    int? IncidentsReported,
    int? IncidentsResolved,
    long? SignalsDetected,
    long? SignalsInvestigated,
    long? EventsAnalyzed,
    DateTimeOffset? CreatedAtSource,
    DateTimeOffset ReadAt);

/// <summary>The summary reports of the security mirror (M43), read by the filing of their PDFs and by the CRM's monthly summary.</summary>
public interface ISecurityReports
{
    /// <summary>
    /// The monthly summary reports of a source whose period starts on or after <paramref name="periodFrom"/>, oldest period first; only
    /// of <paramref name="organizationIds"/> when given.
    /// </summary>
    Task<IReadOnlyList<SummaryReportView>> GetMonthlyReportsAsync(
        string system, DateOnly periodFrom, IReadOnlyCollection<Guid>? organizationIds, CancellationToken cancellationToken);
}
