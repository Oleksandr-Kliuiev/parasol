using System.Text.Json;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Coverage;

/// <summary>The rules of one coverage check (M40), kept apart from the database so they can be checked on their own.</summary>
internal static class CoverageGapRules
{
    /// <summary>
    /// Applies what <paramref name="rule"/> found to its stored gaps: every open gap and every closed one it found again. A finding
    /// opens a gap or keeps it open (a closed one opens again, a new occurrence); an open gap it no longer finds counts a clean
    /// check and closes at <see cref="CoverageGaps.CleanChecksToClose"/>. Changes the stored gaps in place and returns the new ones.
    /// </summary>
    public static (IReadOnlyList<Alert> Added, CoverageCheckResult Result) Apply(
        string rule, AlertKind kind, IReadOnlyCollection<CoverageFinding> findings, IReadOnlyCollection<Alert> stored, DateTimeOffset now)
    {
        var byExternalId = stored.ToDictionary(a => a.ExternalId, StringComparer.Ordinal);
        var found = new HashSet<string>(StringComparer.Ordinal);
        var added = new List<Alert>();
        int opened = 0, reopened = 0, resolved = 0;
        foreach (var finding in findings.DistinctBy(f => f.Subject, StringComparer.Ordinal))
        {
            var id = Alert.GapId(rule, finding.Subject);
            found.Add(id);
            if (byExternalId.TryGetValue(id, out var gap))
            {
                reopened += gap.Found(kind, finding, Facts(finding), now) == AlertChange.Reopened ? 1 : 0;
            }
            else
            {
                added.Add(Alert.Gap(rule, kind, finding, Facts(finding), now));
                opened++;
            }
        }

        foreach (var gap in stored.Where(a => a.State != AlertState.Resolved && !found.Contains(a.ExternalId)))
        {
            resolved += gap.NotFound(now) ? 1 : 0;
        }

        return (added, new CoverageCheckResult(1, found.Count, opened, reopened, resolved));
    }

    /// <summary>The finding's facts as one JSON object in a fixed order, so the same facts are never a change; none when too long.</summary>
    public static string? Facts(CoverageFinding finding)
    {
        if (finding.Facts.Count == 0)
        {
            return null;
        }

        var json = JsonSerializer.Serialize(new SortedDictionary<string, string>(finding.Facts.ToDictionary(), StringComparer.Ordinal));
        return json.Length <= Alert.FactsLength ? json : null;
    }
}

/// <summary>
/// Checks the coverage rules of a source after a complete read of it (M40) and stores what they find as alerts of the CRM's own
/// system. One rule at a time, each in one transaction under the lock of those alerts, where the rule's setting is read too: a
/// check never crosses a person switching the rule off, and a rule switched off closes its open gaps instead of checking.
/// </summary>
internal sealed class CoverageChecks(ServiceDbContext db, IEnumerable<ICoverageRule> rules, TimeProvider time) : ICoverageCheck
{
    public const string LockResource = "service-alerts:" + CoverageGaps.System;

    public async Task<CoverageCheckResult> CheckAsync(string system, IReadOnlyCollection<Guid> organizations, CancellationToken cancellationToken)
    {
        var total = CoverageCheckResult.None;
        foreach (var rule in rules.Where(r => r.System == system).OrderBy(r => r.Code, StringComparer.Ordinal))
        {
            total += await LockedAsync(async ct =>
            {
                var setting = await db.CoverageRuleSettings.AsNoTracking().SingleOrDefaultAsync(s => s.Code == rule.Code, ct);
                var now = time.GetUtcNow();
                if (setting is { Enabled: false })
                {
                    return CoverageCheckResult.None with { Resolved = await CloseOpenAsync(rule.Code, now, ct) };
                }

                var threshold = rule.Threshold is { } limit ? setting?.Threshold ?? limit.Default : (int?)null;
                var findings = await rule.FindAsync(new CoverageCheck(now, threshold, organizations), ct);
                var ids = findings.Select(f => Alert.GapId(rule.Code, f.Subject)).Distinct(StringComparer.Ordinal).ToList();
                var stored = await db.Alerts.Include(a => a.Hold)
                    .Where(a => a.System == CoverageGaps.System && a.Rule == rule.Code && (a.State != AlertState.Resolved || ids.Contains(a.ExternalId)))
                    .ToListAsync(ct);
                var (added, result) = CoverageGapRules.Apply(rule.Code, rule.Kind, findings, stored, now);
                db.Alerts.AddRange(added);
                return result;
            }, cancellationToken);
        }

        return total;
    }

    /// <summary>Closes every open gap of a rule (switched off); call it inside <see cref="LockedAsync{T}"/>. Returns how many it closed.</summary>
    public async Task<int> CloseOpenAsync(string rule, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var open = await db.Alerts.Where(a => a.System == CoverageGaps.System && a.Rule == rule && a.State != AlertState.Resolved)
            .ToListAsync(cancellationToken);
        return open.Count(gap => gap.Resolve(now));
    }

    /// <summary>
    /// One unit of work on the gaps and the rules' settings: the reads, the lock and the writes land together, and SQL Server's retry
    /// strategy repeats it as a whole, starting from the database again each time.
    /// </summary>
    public async Task<T> LockedAsync<T>(Func<CancellationToken, Task<T>> work, CancellationToken cancellationToken) =>
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async ct =>
        {
            // Also the events a failed attempt queued (M43: a gap that became urgent): the new attempt raises its own.
            foreach (var entry in db.ChangeTracker.Entries()
                         .Where(e => e.Entity is Alert or AlertHold or CoverageRuleSetting or Crm.Infrastructure.Persistence.OutboxMessage).ToList())
            {
                entry.State = EntityState.Detached;
            }

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource={LockResource}, @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=30000;
                IF @r < 0 THROW 51000, 'Another check of the coverage gaps is being stored.', 1;
                """, ct);
            var result = await work(ct);
            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            return result;
        }, cancellationToken);
}
