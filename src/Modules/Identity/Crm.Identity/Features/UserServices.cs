using Crm.Authorization;
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

        var now = timeProvider.GetUtcNow();
        user.RecordSignIn(identity.UserPrincipalName, identity.DisplayName, identity.Email, identity.Department, identity.JobTitle, now);
        if (identity.Roles is { } roles)
        {
            // The token was issued by Entra for this sign-in: its roles are what the directory assigns right now (DEV-10).
            user.ConfirmRoles(roles.Where(CrmRoles.All.Contains), now);
        }

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

/// <summary>Sessions and what they may do (DEV-10); one read answers both, so a replica's cache holds one entry per session.</summary>
internal sealed class SessionDirectory(IdentityDbContext db) : ISessionDirectory
{
    public async Task<Guid> StartAsync(Guid userId, DateTimeOffset at, CancellationToken cancellationToken)
    {
        var session = UserSession.Start(userId, at);
        db.UserSessions.Add(session);
        await db.SaveChangesAsync(cancellationToken);
        return session.Id;
    }

    public async Task EndAsync(Guid sessionId, string reason, DateTimeOffset at, CancellationToken cancellationToken)
    {
        if (await db.UserSessions.SingleOrDefaultAsync(s => s.Id == sessionId, cancellationToken) is { } session)
        {
            session.End(reason, at);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    public async Task<SessionState> GetAsync(Guid userId, Guid sessionId, CancellationToken cancellationToken)
    {
        // One round trip: the user, whether this session is open and when the directory last confirmed the user's tenant.
        var row = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => new
            {
                u.IsActive,
                u.Roles,
                u.RolesVersion,
                u.RolesVerifiedAt,
                DirectoryConfirmedAt = db.DirectoryRoleConfirmations
                    .Where(c => c.TenantId == u.TenantId).Select(c => (DateTimeOffset?)c.ConfirmedAt).FirstOrDefault(),
                Open = db.UserSessions.Any(s => s.Id == sessionId && s.UserId == u.Id && s.EndedAt == null),
            })
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null)
        {
            return new SessionState(false, false, [], 0, null);
        }

        var roles = row.Roles.Length == 0 ? [] : row.Roles.Split(',');
        // The later of the user's own confirmation (a sign-in, a change) and the reading that covered the whole tenant.
        var verified = (row.RolesVerifiedAt, row.DirectoryConfirmedAt) switch
        {
            ({ } own, { } directory) => own > directory ? own : directory,
            var (own, directory) => own ?? directory,
        };
        return new SessionState(row.Open, row.IsActive, roles, row.RolesVersion, verified);
    }
}

/// <summary>Applies the directory's role assignments to the CRM users of a tenant (DEV-10).</summary>
internal sealed class UserRoleDirectory(IdentityDbContext db) : IUserRoleDirectory
{
    public async Task<RoleSyncResult> ApplyAsync(
        string tenantId, IReadOnlyDictionary<string, IReadOnlyCollection<string>> rolesByObjectId, DateTimeOffset verifiedAt, CancellationToken cancellationToken)
    {
        var confirmation = await db.DirectoryRoleConfirmations.SingleOrDefaultAsync(c => c.TenantId == tenantId, cancellationToken);
        if (confirmation is null)
        {
            db.DirectoryRoleConfirmations.Add(DirectoryRoleConfirmation.For(tenantId, verifiedAt));
        }
        else if (!confirmation.Advance(verifiedAt))
        {
            return new RoleSyncResult(0, 0, Superseded: true);
        }

        var users = await db.Users.Where(u => u.TenantId == tenantId).ToListAsync(cancellationToken);
        var changed = 0;
        foreach (var user in users)
        {
            var roles = rolesByObjectId.TryGetValue(user.ObjectId, out var assigned) ? assigned.Where(CrmRoles.All.Contains) : [];
            changed += user.ApplyDirectoryRoles(roles, verifiedAt) ? 1 : 0;
        }

        // The confirmation and the changed users in one transaction: the tenant is never confirmed with roles left unapplied.
        await db.SaveChangesAsync(cancellationToken);
        return new RoleSyncResult(users.Count, changed);
    }
}

/// <summary>
/// Server-side sessions (DEV-10; docs/04 §8 proposes 90 days): a session that ended — signed out, or past its absolute
/// lifetime, counted from its start — and is older than the approved period is removed.
/// </summary>
internal sealed class SessionRetention(IdentityDbContext db) : Crm.Privacy.Contracts.IRetentionContributor
{
    public const string Class = "identity.sessions";

    public string DataClass => Class;

    public Task<int> CountAsync(DateTimeOffset olderThan, CancellationToken cancellationToken) =>
        db.UserSessions.CountAsync(s => (s.EndedAt ?? s.StartedAt) < olderThan, cancellationToken);

    public async Task<int> ApplyAsync(DateTimeOffset olderThan, int batchSize, CancellationToken cancellationToken)
    {
        var ids = await db.UserSessions.Where(s => (s.EndedAt ?? s.StartedAt) < olderThan)
            .OrderBy(s => s.StartedAt).Select(s => s.Id).Take(batchSize).ToListAsync(cancellationToken);
        return ids.Count == 0 ? 0 : await db.UserSessions.Where(s => ids.Contains(s.Id)).ExecuteDeleteAsync(cancellationToken);
    }
}
