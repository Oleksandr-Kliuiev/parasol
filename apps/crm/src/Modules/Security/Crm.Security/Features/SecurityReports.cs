using Crm.Security.Contracts;
using Crm.Security.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Features;

/// <summary>The monthly summary reports of the mirror for the rest of the CRM (M43): the PDF filing and the CRM's monthly summary.</summary>
internal sealed class SecurityReports(SecurityDbContext db) : ISecurityReports
{
    public const string MonthlyType = "monthly_summary";

    public async Task<IReadOnlyList<SummaryReportView>> GetMonthlyReportsAsync(
        string system, DateOnly periodFrom, IReadOnlyCollection<Guid>? organizationIds, CancellationToken cancellationToken)
    {
        var query = db.SummaryReports.AsNoTracking().Where(r => r.System == system && r.Type == MonthlyType && r.PeriodStart >= periodFrom);
        if (organizationIds is not null)
        {
            var ids = organizationIds.Distinct().ToList();
            query = query.Where(r => ids.Contains(r.OrganizationId));
        }

        return await query.OrderBy(r => r.PeriodStart).ThenBy(r => r.ExternalId)
            .Select(r => new SummaryReportView(
                r.System, r.ExternalId, r.OrganizationId, r.ExternalOrganizationId, r.Type, r.PeriodStart, r.PeriodEnd, r.Url, r.AgentsCount, r.IncidentsReported,
                r.IncidentsResolved, r.SignalsDetected, r.SignalsInvestigated, r.EventsAnalyzed, r.CreatedAtSource, r.ReadAt))
            .ToListAsync(cancellationToken);
    }
}
