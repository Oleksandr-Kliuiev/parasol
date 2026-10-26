using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Coverage;

/// <summary>A person's change to one coverage rule (M40): whether it checks, and its limit when it has one.</summary>
public sealed record ChangeCoverageRuleRequest(bool Enabled, int? Threshold);

internal sealed class ChangeCoverageRuleRequestValidator : AbstractValidator<ChangeCoverageRuleRequest>
{
    // The rule's own range is checked against the rule; this keeps the number within reason before anything is read.
    public ChangeCoverageRuleRequestValidator() => RuleFor(x => x.Threshold).InclusiveBetween(1, 1000).When(x => x.Threshold is not null);
}

/// <summary>
/// One coverage rule as its settings show it (M40): what it watches, whether it checks, the limit in force with the range a person
/// may choose from, how many of its gaps are open now, and who changed it last. The ETag goes with a change.
/// </summary>
public sealed record CoverageRuleItem(
    string Code,
    string System,
    AlertKind Kind,
    CoverageThreshold? Threshold,
    bool Enabled,
    int? Value,
    int OpenGaps,
    DateTimeOffset? ChangedAt,
    string? ChangedByName,
    string? Etag);

/// <summary>
/// The settings of the coverage rules (M40). Every rule has its row from the migration that brings it, with its defaults; a person
/// changes it with the ETag they read. Switching a rule off closes its open gaps in the same transaction, under the lock the checks
/// take, so no check stores a gap of a rule that is off.
/// </summary>
internal sealed class CoverageSettings(ServiceDbContext db, IEnumerable<ICoverageRule> rules, CoverageChecks checks, IUserDirectory users, TimeProvider time)
    : ICoverageLimits
{
    public async Task<int?> LimitAsync(string rule, CancellationToken cancellationToken)
    {
        if (rules.FirstOrDefault(r => r.Code == rule)?.Threshold is not { } limit)
        {
            return null;
        }

        var set = await db.CoverageRuleSettings.AsNoTracking().Where(s => s.Code == rule).Select(s => s.Threshold).SingleOrDefaultAsync(cancellationToken);
        return set ?? limit.Default;
    }

    public async Task<IReadOnlyList<CoverageRuleItem>> ListAsync(CancellationToken ct)
    {
        // Tracked: each ETag comes from its setting's row version.
        var settings = await db.CoverageRuleSettings.ToListAsync(ct);
        var open = await db.Alerts.AsNoTracking()
            .Where(a => a.System == CoverageGaps.System && a.Rule != null && a.State != AlertState.Resolved)
            .GroupBy(a => a.Rule!).Select(g => new { Rule = g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.Rule, g => g.Count, ct);
        var changers = settings.Select(s => s.ModifiedBy ?? s.CreatedBy).OfType<Guid>().Distinct().ToList();
        var people = changers.Count == 0 ? new Dictionary<Guid, UserSummary>() : await users.GetUsersAsync(changers, ct);
        return rules.OrderBy(r => r.Code, StringComparer.Ordinal).Select(rule =>
        {
            var setting = settings.SingleOrDefault(s => s.Code == rule.Code);
            var by = setting?.ModifiedBy ?? setting?.CreatedBy;
            return new CoverageRuleItem(
                rule.Code, rule.System, rule.Kind, rule.Threshold, setting?.Enabled ?? true,
                rule.Threshold is { } limit ? setting?.Threshold ?? limit.Default : null,
                open.GetValueOrDefault(rule.Code),
                setting?.ModifiedAt,
                setting?.ModifiedAt is not null && by is { } id ? people.GetValueOrDefault(id)?.DisplayName : null,
                setting is null ? null : db.GetETag(setting));
        }).ToList();
    }

    public async Task<Result<string>> ChangeAsync(string code, ChangeCoverageRuleRequest request, string ifMatch, CancellationToken ct)
    {
        if (rules.FirstOrDefault(r => r.Code == code) is not { } rule)
        {
            return Error.NotFound("SRV_COVERAGE_RULE_NOT_FOUND", "There is no such coverage rule.");
        }

        if (rule.Threshold is { } limit ? request.Threshold is not { } value || value < limit.Min || value > limit.Max : request.Threshold is not null)
        {
            return Error.Validation("SRV_COVERAGE_THRESHOLD", rule.Threshold is { } range
                ? $"Choose a limit from {range.Min} to {range.Max}."
                : "This rule has no limit.");
        }

        return await checks.LockedAsync<Result<string>>(async c =>
        {
            if (await db.CoverageRuleSettings.SingleOrDefaultAsync(s => s.Code == code, c) is not { } setting)
            {
                return Error.NotFound("SRV_COVERAGE_RULE_NOT_FOUND", "The rule has no setting to change.");
            }

            if (!db.ApplyIfMatch(setting, ifMatch))
            {
                return Error.Validation("SRV_COVERAGE_ETAG_INVALID", "The If-Match header is not an ETag of this rule.");
            }

            if (db.IsStale(setting))
            {
                return Error.PreconditionFailed("CONCURRENCY_CONFLICT", "The rule changed. Read it again and decide again.");
            }

            setting.Change(request.Enabled, request.Threshold);
            if (!request.Enabled)
            {
                await checks.CloseOpenAsync(code, time.GetUtcNow(), c);
            }

            return code;
        }, ct);
    }
}
