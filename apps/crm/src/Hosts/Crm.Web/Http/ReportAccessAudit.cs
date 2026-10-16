using System.Text.Json;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.Reports;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Operations;

namespace Crm.Web.Http;

/// <summary>
/// Writes the report-access trail into <c>audit.AuditEntries</c> as module <c>reports</c> (the mart and the BI API read many
/// modules and own no table). A read still answers during read-only maintenance, so the entry is bookkeeping of that read.
/// </summary>
internal sealed class ReportAccessAudit(IntegrationDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time) : IReportAccessAudit
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task RecordAsync(
        ReportAccessKind kind, string dataset, string? client, DateOnly? from, DateOnly? to, string? detail, CancellationToken cancellationToken)
    {
        // The dataset name comes from the URL: cut and made printable before it reaches the trail.
        var name = new string(dataset.Take(64).Where(c => !char.IsControl(c)).ToArray());
        db.AuditEntries.Add(new AuditEntry
        {
            At = time.GetUtcNow(),
            UserId = user.UserId,
            UserName = user.IsAuthenticated && user.UserId is not null ? user.DisplayName : null,
            Action = kind == ReportAccessKind.MartExport ? AuditActions.Export : AuditActions.Read,
            Module = "reports",
            EntityType = kind.ToString(),
            EntityId = Guid.Empty,
            Changes = JsonSerializer.Serialize(new { dataset = name, client, from, to, detail }, Json),
            CorrelationId = request.CorrelationId,
            IpAddress = request.IpAddress,
        });
        using var allowed = MaintenanceScope.AllowWrites("report-access-audit");
        await db.SaveChangesAsync(cancellationToken);
    }
}
