using System.Globalization;
using Crm.Audit.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;

namespace Crm.Audit.Features;

/// <summary>
/// Audit's part in a restore (DEV-13, DEV-04): where the restored chain ends, so the operator can compare it with the last
/// AUDIT_CHECKPOINT anchor written before the restore point and run the full verification (allowed during maintenance).
/// </summary>
internal sealed class AuditRestoreParticipant(AuditDbContext db) : IRestoreParticipant
{
    public string Area => "audit";

    public Task<int> InFlightAsync(CancellationToken cancellationToken) => Task.FromResult(0);

    public async Task<IReadOnlyList<RestoreLine>> CheckAsync(DateTimeOffset restorePoint, CancellationToken cancellationToken)
    {
        var last = await db.IntegrityCheckpoints.AsNoTracking().OrderByDescending(c => c.ToId).FirstOrDefaultAsync(cancellationToken);
        var after = last is null ? 0 : await db.AuditEntries.AsNoTracking().CountAsync(e => e.Id > last.ToId, cancellationToken);
        return
        [
            new RestoreLine(Area, "audit chain", last is null
                    ? "No integrity checkpoint in the restored copy yet."
                    : string.Create(CultureInfo.InvariantCulture,
                        $"The last checkpoint {last.Id} covers entries up to {last.ToId} ({last.CreatedAt:yyyy-MM-dd HH:mm} UTC); {after} entries follow it."),
                "Run audit-integrity-full (Admin → Jobs) and compare with the last AUDIT_CHECKPOINT anchor before the restore point (runbook 08 § 5).",
                false),
        ];
    }

    public Task<IReadOnlyList<RestoreLine>> ReconcileAsync(
        DateTimeOffset restorePoint, IReadOnlyList<ExternalEffectEntry> effects, bool apply, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<RestoreLine>>([]);
}
