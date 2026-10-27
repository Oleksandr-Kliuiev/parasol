using Crm.Identity.Contracts;
using Crm.Identity.Domain;
using Crm.Identity.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Identity.Features;

internal sealed class TechnicianDirectory(IdentityDbContext db, TimeProvider time) : ITechnicianDirectory
{
    public async Task<IReadOnlyDictionary<string, Guid?>> ResolveAsync(IReadOnlyCollection<TechnicianRef> technicians, CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, Guid?>(StringComparer.Ordinal);
        var bySystem = technicians.Where(t => !string.IsNullOrWhiteSpace(t.ExternalId)).GroupBy(t => t.System);
        var now = time.GetUtcNow();
        foreach (var group in bySystem)
        {
            var ids = group.Select(t => t.ExternalId).Distinct().ToList();
            var existing = await db.TechnicianMappings.Where(m => m.System == group.Key && ids.Contains(m.ExternalId)).ToDictionaryAsync(m => m.ExternalId, cancellationToken);
            var emails = group.Where(t => t.Email != null && !existing.ContainsKey(t.ExternalId)).Select(t => t.Email!.Trim().ToLowerInvariant()).Distinct().ToList();
            var users = emails.Count == 0
                ? []
                : await db.Users.AsNoTracking().Where(u => u.Email != null && emails.Contains(u.Email)).ToDictionaryAsync(u => u.Email!, u => u.Id, cancellationToken);

            foreach (var technician in group.DistinctBy(t => t.ExternalId))
            {
                if (existing.TryGetValue(technician.ExternalId, out var mapping))
                {
                    // Keep the last-seen time coarse: one write per technician per hour at most.
                    if (now - mapping.LastSeenAt > TimeSpan.FromHours(1))
                    {
                        mapping.Seen(technician, now);
                    }
                }
                else
                {
                    var email = technician.Email?.Trim().ToLowerInvariant();
                    mapping = TechnicianMapping.Register(technician, email is not null && users.TryGetValue(email, out var userId) ? userId : null, now);
                    db.TechnicianMappings.Add(mapping);
                }

                result[technician.ExternalId] = mapping.UserId;
            }
        }

        if (db.ChangeTracker.HasChanges())
        {
            await db.SaveChangesAsync(cancellationToken);
        }

        return result;
    }

    public async Task<IReadOnlyList<TechnicianListing>> ListAsync(string system, CancellationToken cancellationToken) =>
        await db.TechnicianMappings.AsNoTracking().Where(m => m.System == system)
            .OrderBy(m => m.Name).ThenBy(m => m.ExternalId)
            .Select(m => new TechnicianListing(m.ExternalId, m.Name, m.Email, m.UserId, m.Shared))
            .ToListAsync(cancellationToken);
}
