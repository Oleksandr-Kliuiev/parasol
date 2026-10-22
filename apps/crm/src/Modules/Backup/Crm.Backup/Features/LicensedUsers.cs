using Crm.Backup.Contracts;
using Crm.Backup.Domain;
using Crm.Backup.Persistence;
using Crm.Licensing.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Backup.Features;

/// <summary>
/// How many of a customer's licensed Microsoft 365 users have their mailbox in backup (M42). Licences come from the Licensing
/// module (Partner Center's daily reading of assigned licences); a customer without a reading has no answer, never a zero, and
/// the check says so. Partner Center counts licences per SKU, not per person, so this is a count: the SKUs that give a mailbox
/// (<see cref="BackupOptions.MailboxSkus"/>) against the distinct mailboxes the backup watches.
/// </summary>
internal sealed class LicensedUsers(BackupDbContext db, ILicensingApi licensing, IOptions<BackupOptions> options, TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public async Task<IReadOnlyDictionary<Guid, LicenceCount>> CountAsync(IReadOnlyCollection<Guid> organizations, CancellationToken ct)
    {
        if (organizations.Count == 0)
        {
            return new Dictionary<Guid, LicenceCount>();
        }

        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        var readings = await licensing.GetLicenseReadingsAsync(organizations, today, ct);
        var backedUp = await BackedUpMailboxesAsync(organizations, ct);
        var o = options.Value;
        return readings.GroupBy(r => r.OrganizationId).ToDictionary(g => g.Key, g =>
        {
            var counted = g.Where(r => o.GivesMailbox(r.SkuPartNumber)).ToList();
            return new LicenceCount(
                counted.Sum(r => r.Assigned), backedUp.GetValueOrDefault(g.Key), g.Max(r => r.SnapshotDate),
                counted.Select(r => r.SkuPartNumber).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.Ordinal).ToList());
        });
    }

    /// <summary>The distinct mailboxes in a mail backup of each customer: added to it, whatever their last backup did.</summary>
    private async Task<Dictionary<Guid, int>> BackedUpMailboxesAsync(IReadOnlyCollection<Guid> organizations, CancellationToken ct)
    {
        var rows = await (from e in db.Entities.AsNoTracking()
                          join t in db.Tasks.AsNoTracking() on e.TaskId equals t.Id
                          join a in db.Accounts.AsNoTracking() on t.AccountId equals a.Id
                          where organizations.Contains(a.OrganizationId) && t.Service == BackupService.Mail
                          select new { a.OrganizationId, e.Name, e.Status })
            .ToListAsync(ct);
        return rows.Where(r => !BackupStatuses.IsNotActive(r.Status) && !BackupStatuses.IsAside(r.Status))
            .GroupBy(r => r.OrganizationId)
            .ToDictionary(g => g.Key, g => g.Select(r => r.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }
}

/// <summary>
/// One customer's count: users holding a licence with a mailbox, mailboxes in backup, the day of the licence reading and the SKUs
/// counted.
/// </summary>
internal sealed record LicenceCount(int Licensed, int BackedUp, DateOnly ReadOn, IReadOnlyList<string> Skus)
{
    public int Missing => Math.Max(Licensed - BackedUp, 0);
}
