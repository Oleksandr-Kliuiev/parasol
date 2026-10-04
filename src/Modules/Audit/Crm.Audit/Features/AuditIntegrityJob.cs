using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Crm.Audit.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Audit.Features;

public sealed record AuditIntegrityResult(bool Intact, int Verified, AuditIntegrityCheckpoint? Added, string? Mismatch);

public sealed class AuditIntegrityOptions
{
    public const string SectionName = "Audit:Integrity";

    /// <summary>
    /// How old an entry must be before a checkpoint covers it. Identity values are handed out before commit: a checkpoint
    /// that ran past an entry still being written would later count one entry more than it chained.
    /// </summary>
    public TimeSpan SettleTime { get; set; } = TimeSpan.FromMinutes(5);
}

/// <summary>
/// Keeps and checks the audit hash chain (DEV-04). Each run first recomputes the newest checkpoint and one older one in
/// turn — a changed, removed or inserted entry in their range changes the hash — and then chains the entries written since.
/// Every new checkpoint is also logged as <c>AUDIT_CHECKPOINT</c>: the log workspace is an independent copy of the anchors
/// that the database owner cannot rewrite, which the chain in the database alone could never be (docs/runbooks/08).
/// </summary>
public sealed class AuditIntegrityJob(AuditDbContext db, TimeProvider time, IOptions<AuditIntegrityOptions> options, ILogger<AuditIntegrityJob> logger)
{
    public const string JobId = "audit-integrity";

    /// <summary>The full recheck, started by hand from the job list (docs/runbooks/08).</summary>
    public const string FullJobId = "audit-integrity-full";
    private const int BatchSize = 50_000;

    public async Task<AuditIntegrityResult> RunAsync(CancellationToken ct)
    {
        var checkpoints = await db.IntegrityCheckpoints.AsNoTracking().OrderBy(c => c.ToId).Select(c => new { c.Id, c.ToId }).ToListAsync(ct);
        var toVerify = new List<long>();
        if (checkpoints.Count > 0)
        {
            toVerify.Add(checkpoints[^1].Id);
            // One older checkpoint a day, in turn, so the whole chain is rechecked over time.
            var older = checkpoints[time.GetUtcNow().DayOfYear % checkpoints.Count].Id;
            if (older != checkpoints[^1].Id)
            {
                toVerify.Add(older);
            }
        }

        if (await FirstMismatchAsync(toVerify, ct) is { } mismatch)
        {
            return new AuditIntegrityResult(false, toVerify.Count, null, mismatch);
        }

        var lastId = checkpoints.Count == 0 ? (long?)null : checkpoints[^1].Id;
        var last = lastId is null ? null : await db.IntegrityCheckpoints.AsNoTracking().SingleAsync(c => c.Id == lastId, ct);
        var after = last?.ToId ?? 0;
        // Only settled entries, in an unbroken run of ids: up to the first entry younger than the settle time. READCOMMITTEDLOCK
        // waits for an insert still in flight instead of reading past it, which row versioning (RCSI, the Azure SQL default)
        // would do.
        var settled = time.GetUtcNow() - options.Value.SettleTime;
        var next = await db.AuditEntries
            .FromSqlInterpolated($"""
                SELECT TOP ({BatchSize}) * FROM [audit].[AuditEntries] WITH (READCOMMITTEDLOCK)
                WHERE [Id] > {after}
                  AND [Id] < ISNULL((SELECT MIN([Id]) FROM [audit].[AuditEntries] WITH (READCOMMITTEDLOCK) WHERE [Id] > {after} AND [At] >= {settled}), 9223372036854775807)
                ORDER BY [Id]
                """)
            .AsNoTracking()
            .OrderBy(e => e.Id)
            .Select(Fact)
            .ToListAsync(ct);
        if (next.Count == 0)
        {
            return new AuditIntegrityResult(true, toVerify.Count, null, null);
        }

        var added = new AuditIntegrityCheckpoint
        {
            FromId = next[0].Id,
            ToId = next[^1].Id,
            Entries = next.Count,
            PreviousHash = last?.ChainHash,
            ChainHash = Chain(last?.ChainHash, next),
            CreatedAt = time.GetUtcNow(),
        };
        db.IntegrityCheckpoints.Add(added);
        await db.SaveChangesAsync(ct);
        logger.LogInformation(
            "AUDIT_CHECKPOINT {CheckpointId} {FromId} {ToId} {Entries} {PreviousHash} {ChainHash}",
            added.Id, added.FromId, added.ToId, added.Entries, added.PreviousHash, added.ChainHash);
        return new AuditIntegrityResult(true, toVerify.Count, added, null);
    }

    /// <summary>
    /// Rechecks every checkpoint without adding one — the full verification an operator runs after an incident or before an
    /// audit (docs/runbooks/08). Anchors are compared with the <c>AUDIT_CHECKPOINT</c> log entries separately.
    /// </summary>
    public async Task<AuditIntegrityResult> VerifyAllAsync(CancellationToken ct)
    {
        var all = await db.IntegrityCheckpoints.AsNoTracking().OrderBy(c => c.ToId).Select(c => c.Id).ToListAsync(ct);
        var mismatch = await FirstMismatchAsync(all, ct);
        return new AuditIntegrityResult(mismatch is null, all.Count, null, mismatch);
    }

    private async Task<string?> FirstMismatchAsync(IEnumerable<long> checkpointIds, CancellationToken ct)
    {
        foreach (var id in checkpointIds)
        {
            var checkpoint = await db.IntegrityCheckpoints.AsNoTracking().SingleAsync(c => c.Id == id, ct);
            var entries = await FactsAsync(checkpoint.FromId, checkpoint.ToId, ct);
            var recomputed = Chain(checkpoint.PreviousHash, entries);
            if (entries.Count != checkpoint.Entries || recomputed != checkpoint.ChainHash)
            {
                var mismatch = string.Create(CultureInfo.InvariantCulture,
                    $"Audit entries {checkpoint.FromId}–{checkpoint.ToId} no longer match checkpoint {checkpoint.Id}: {entries.Count} of {checkpoint.Entries} entries, hash {recomputed}.");
                logger.LogCritical("AUDIT_INTEGRITY_MISMATCH {CheckpointId} {FromId} {ToId} {Message}", checkpoint.Id, checkpoint.FromId, checkpoint.ToId, mismatch);
                return mismatch;
            }
        }

        return null;
    }

    /// <summary>The immutable fact of an entry; who did it, from where and what changed are left out (retention may remove them).</summary>
    public sealed record AuditFact(long Id, DateTimeOffset At, string Action, string Module, string EntityType, Guid EntityId, string? CorrelationId);

    private static readonly System.Linq.Expressions.Expression<Func<AuditEntry, AuditFact>> Fact =
        e => new AuditFact(e.Id, e.At, e.Action, e.Module, e.EntityType, e.EntityId, e.CorrelationId);

    private async Task<List<AuditFact>> FactsAsync(long fromId, long toId, CancellationToken ct) =>
        await db.AuditEntries.AsNoTracking().Where(e => e.Id >= fromId && e.Id <= toId).OrderBy(e => e.Id).Select(Fact).ToListAsync(ct);

    /// <summary>h(n) = SHA-256(h(n-1) ‖ fact(n)), hex, starting from the previous checkpoint's hash.</summary>
    public static string Chain(string? previousHash, IEnumerable<AuditFact> facts)
    {
        var hash = previousHash is null ? [] : Convert.FromHexString(previousHash);
        foreach (var fact in facts)
        {
            var line = string.Create(CultureInfo.InvariantCulture,
                $"{fact.Id}|{fact.At.ToUniversalTime():O}|{fact.Action}|{fact.Module}|{fact.EntityType}|{fact.EntityId:N}|{fact.CorrelationId}");
            hash = SHA256.HashData([.. hash, .. Encoding.UTF8.GetBytes(line)]);
        }

        return Convert.ToHexStringLower(hash);
    }
}
