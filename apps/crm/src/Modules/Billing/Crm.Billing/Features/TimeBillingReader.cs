using System.Text.Json;
using Crm.Billing.Contracts;
using Crm.Billing.Domain;
using Crm.Billing.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Billing.Features;

internal sealed class TimeBillingReader(BillingDbContext db) : ITimeBillingReader
{
    public async Task<IReadOnlyList<TimeBillingClaim>> ReadAsync(IReadOnlyCollection<TimeBillingEntry> entries, CancellationToken ct)
    {
        if (entries.Count == 0) return [];
        var ids = JsonSerializer.Serialize(entries.Select(e => e.EntryId).Distinct());
        var organizations = JsonSerializer.Serialize(entries.Select(e => e.OrganizationId).Distinct());
        // Target exact source IDs inside our own schema. Invalid historical time references fail closed for their source
        // organization, including subsidiary lines consolidated onto a parent basis. No full-history scan in application code.
        var rows = await db.Database.SqlQuery<TimeBillingRow>($$"""
            SELECT l.BasisId, COALESCE(l.SourceOrganizationId,b.OrganizationId) OrganizationId, l.SourceRefs,
                   CAST(CASE WHEN l.Origin=N'Collected' AND l.[Group] IN (N'HourlyWork',N'Info') THEN 1 ELSE 0 END AS bit) TimeLine,
                   CAST(CASE WHEN b.Status=N'Exported' THEN 1 ELSE 0 END AS bit) Exported
            FROM billing.BillingLines l JOIN billing.BillingBases b ON b.Id=l.BasisId
            WHERE l.IsDeleted=0 AND b.IsDeleted=0 AND l.Decision<>N'Exclusion'
              AND b.Status IN (N'Approved',N'Exported',N'Failed',N'ReconciliationRequired')
              AND (EXISTS (
                    SELECT 1 FROM OPENJSON(CASE WHEN ISJSON(l.SourceRefs)=1 THEN l.SourceRefs ELSE N'{}' END,N'$.timeEntryIds') j
                    JOIN OPENJSON({{ids}}) i ON TRY_CONVERT(uniqueidentifier,j.[value])=TRY_CONVERT(uniqueidentifier,i.[value]))
                OR (l.Origin=N'Collected' AND l.[Group] IN (N'HourlyWork',N'Info')
                    AND (ISNULL(ISJSON(l.SourceRefs),0)=0 OR NOT EXISTS (SELECT 1 FROM OPENJSON(CASE WHEN ISJSON(l.SourceRefs)=1 THEN l.SourceRefs ELSE N'{}' END,N'$.timeEntryIds') z WHERE TRY_CONVERT(uniqueidentifier,z.[value]) IS NOT NULL))
                    AND COALESCE(l.SourceOrganizationId,b.OrganizationId) IN (SELECT TRY_CONVERT(uniqueidentifier,[value]) FROM OPENJSON({{organizations}}))))
            """).ToListAsync(ct);
        return rows.Select(r => TimeBillingSources.Read(r.BasisId, r.OrganizationId, r.SourceRefs, r.TimeLine, r.Exported)).OfType<TimeBillingClaim>().ToList();
    }

    public async Task<IReadOnlyList<TimeBillingClaim>> ReadExportedBasisAsync(Guid basisId, CancellationToken ct)
    {
        var rows = await (from line in db.BillingLines.AsNoTracking()
            join basis in db.BillingBases.AsNoTracking() on line.BasisId equals basis.Id
            where basis.Id == basisId && basis.Status == BillingBasisStatus.Exported && line.Decision != BillingLineDecision.Exclusion
            select new { basis.Id, OrganizationId = line.SourceOrganizationId ?? basis.OrganizationId, line.SourceRefs, line.Origin, line.Group }).ToListAsync(ct);
        return rows.Select(r => TimeBillingSources.Read(r.Id, r.OrganizationId, r.SourceRefs,
            r.Origin == BillingLineOrigin.Collected && r.Group is BillingGroup.HourlyWork or BillingGroup.Info, true)).OfType<TimeBillingClaim>().ToList();
    }

    private sealed class TimeBillingRow
    {
        public Guid BasisId { get; set; }
        public Guid OrganizationId { get; set; }
        public string? SourceRefs { get; set; }
        public bool TimeLine { get; set; }
        public bool Exported { get; set; }
    }
}
