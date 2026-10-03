using Crm.Identity.Contracts;
using Crm.Identity.Domain;
using Crm.Identity.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Identity.Features;

internal sealed class UserProvisioning(IdentityDbContext db, TimeProvider timeProvider) : IUserProvisioning
{
    private const int MaxAttempts = 3;

    public async Task<UserProfile> EnsureUserAsync(ExternalIdentity identity, CancellationToken cancellationToken)
    {
        for (int attempt = 1; ; attempt++)
        {
            try
            {
                return await UpsertAsync(identity, cancellationToken);
            }
            catch (DbUpdateException) when (attempt < MaxAttempts)
            {
                // A parallel request of the same user inserted or updated the row first. Its sign-in record is as good as ours.
                db.ChangeTracker.Clear();
                var existing = await db.Users.AsNoTracking().SingleOrDefaultAsync(
                    u => u.TenantId == identity.TenantId && u.ObjectId == identity.ObjectId, cancellationToken);
                if (existing is { IsActive: true })
                {
                    return existing.ToProfile();
                }
            }
        }
    }

    private async Task<UserProfile> UpsertAsync(ExternalIdentity identity, CancellationToken cancellationToken)
    {
        var user = await db.Users.SingleOrDefaultAsync(
            u => u.TenantId == identity.TenantId && u.ObjectId == identity.ObjectId, cancellationToken);
        if (user is null)
        {
            user = User.Create(identity.TenantId, identity.ObjectId);
            db.Users.Add(user);
        }

        user.RecordSignIn(
            identity.UserPrincipalName, identity.DisplayName, identity.Email, identity.Department, identity.JobTitle,
            timeProvider.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        return user.ToProfile();
    }
}

internal sealed class UserDirectory(IdentityDbContext db) : IUserDirectory
{
    public async Task<UserProfile?> GetProfileAsync(Guid userId, CancellationToken cancellationToken)
    {
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId, cancellationToken);
        return user?.ToProfile();
    }

    public async Task<IReadOnlyDictionary<Guid, UserSummary>> GetUsersAsync(
        IReadOnlyCollection<Guid> userIds, CancellationToken cancellationToken)
    {
        if (userIds.Count == 0)
        {
            return new Dictionary<Guid, UserSummary>();
        }

        return await db.Users.AsNoTracking()
            .Where(u => userIds.Contains(u.Id))
            .Select(u => new UserSummary(u.Id, u.DisplayName, u.Email, u.IsActive))
            .ToDictionaryAsync(u => u.Id, cancellationToken);
    }
}

internal static class UserMappings
{
    public static UserProfile ToProfile(this User user) =>
        new(user.Id, user.DisplayName, user.Email, user.PreferredLanguage, user.IsActive);
}

internal sealed class UserDirectorySync(IdentityDbContext db) : IUserDirectorySync
{
    public async Task<DirectorySyncResult> ApplyAsync(IReadOnlyCollection<DirectoryUserChange> changes, CancellationToken cancellationToken)
    {
        int matched = 0, updated = 0, deactivated = 0, reactivated = 0;
        foreach (var batch in changes.Chunk(500))
        {
            var objectIds = batch.Select(c => c.ObjectId).ToList();
            var users = await db.Users.Where(u => objectIds.Contains(u.ObjectId)).ToListAsync(cancellationToken);
            foreach (var change in batch)
            {
                var user = users.SingleOrDefault(u => u.ObjectId == change.ObjectId && u.TenantId == change.TenantId);
                if (user is null)
                {
                    continue;
                }

                matched++;
                if (change.Removed || change.AccountEnabled == false)
                {
                    deactivated += user.Deactivate() ? 1 : 0;
                    continue;
                }

                if (change.AccountEnabled == true && user.Reactivate())
                {
                    reactivated++;
                }

                if (!change.Removed && change.DisplayName is not null &&
                    user.ApplyDirectoryProfile(change.DisplayName, change.UserPrincipalName, change.Email, change.Department, change.JobTitle))
                {
                    updated++;
                }
            }

            await db.SaveChangesAsync(cancellationToken);
        }

        return new DirectorySyncResult(matched, updated, deactivated, reactivated);
    }
}
