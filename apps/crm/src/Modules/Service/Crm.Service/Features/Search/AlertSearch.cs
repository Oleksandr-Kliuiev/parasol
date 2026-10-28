using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Search;

/// <summary>
/// Alerts in the global search: those not resolved, by title and device name, and a word may name the customer ("disk fjord"). In the
/// queue's order (critical first, the longest waiting first), with alerts hidden in Parasoll for now after the others and marked as
/// such. A hit opens the alert's panel in the queue.
/// </summary>
internal sealed class AlertSearchProvider(ServiceDbContext db, ICustomerSearchWords words, ICustomersApi customers, TimeProvider time) : ISearchProvider
{
    public string Group => "alerts";

    public string RequiredPermission => Permissions.ServiceRead;

    public int Order => 24;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var named = await words.NamedAsync(term, cancellationToken);
        var now = time.GetUtcNow();
        var rows = await db.Alerts.AsNoTracking()
            .Where(a => a.State != AlertState.Resolved)
            .WhereWords(term, named,
                word => a => a.Title.Contains(word) || (a.DeviceName != null && a.DeviceName.Contains(word)),
                ids => a => ids.Contains(a.OrganizationId))
            .OrderBy(a => a.Hold != null && a.Hold.Until > now ? 1 : 0)
            .ThenBy(a => a.Severity == AlertSeverity.Critical ? 0 : a.Severity == AlertSeverity.Warning ? 1 : 2)
            .ThenBy(a => a.CreatedAtSource).ThenBy(a => a.Id)
            .Take(take)
            .Select(a => new
            {
                a.Id, a.OrganizationId, a.System, a.Severity, a.Title, a.DeviceName, a.Rule, a.Facts,
                HiddenUntil = a.Hold != null && a.Hold.Until > now ? a.Hold.Until : (DateTimeOffset?)null,
            })
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return [];
        }

        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), cancellationToken);
        return rows.Select(r =>
            {
                // A gap Parasoll found is worded from its rule and facts in the reader's language, as in the queue; the alert's own
                // facts are set after the gap's, so a gap fact can never stand in for them.
                var facts = new Dictionary<string, string>(CoverageGaps.ReadFacts(r.Facts) ?? new Dictionary<string, string>())
                {
                    ["severity"] = r.Severity.ToString(),
                    ["system"] = r.System,
                };
                if (r.Rule is { } rule)
                {
                    facts["rule"] = rule;
                }

                if (r.DeviceName is { Length: > 0 } device)
                {
                    facts["device"] = device;
                }

                if (r.HiddenUntil is { } until)
                {
                    facts["hiddenUntil"] = until.ToString("O", CultureInfo.InvariantCulture);
                }

                return new SearchHit(r.Id, r.Title, organizations.GetValueOrDefault(r.OrganizationId), $"/alerts?alert={r.Id}") { Facts = facts };
            })
            .ToList();
    }
}
