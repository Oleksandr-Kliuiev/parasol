using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Search;

/// <summary>
/// Saved tickets in the global search, open and closed: a number alone is the ticket's own (#1234 or 1234, as on the tickets page),
/// other words are looked for in the title and may name the customer ("printer fjord"). Open first, then the most recently active.
/// A hit opens the ticket's panel on the tickets page.
/// </summary>
internal sealed class TicketSearchProvider(ServiceDbContext db, ICustomerSearchWords words, ICustomersApi customers) : ISearchProvider
{
    public string Group => "tickets";

    public string RequiredPermission => Permissions.ServiceRead;

    public int Order => 26;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        IQueryable<Ticket> tickets = db.Tickets.AsNoTracking();
        if (Number(term) is { } number)
        {
            tickets = tickets.Where(t => t.ExternalId == number);
        }
        else
        {
            var named = await words.NamedAsync(term, cancellationToken);
            tickets = tickets.WhereWords(term, named, word => t => t.Title.Contains(word), ids => t => ids.Contains(t.OrganizationId));
        }

        var rows = await tickets
            .OrderBy(t => t.IsOpen ? 0 : 1).ThenByDescending(t => t.LastActivityAt ?? t.CreatedAtSource).ThenByDescending(t => t.Id)
            .Take(take)
            .Select(t => new { t.Id, t.ExternalId, t.OrganizationId, t.Title, t.Status, t.IsOpen })
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return [];
        }

        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), cancellationToken);
        return rows.Select(r => new SearchHit(
                r.Id, $"#{r.ExternalId} {r.Title}", organizations.GetValueOrDefault(r.OrganizationId), $"/tickets?ticket={r.Id}")
            {
                Facts = new Dictionary<string, string> { ["status"] = r.Status, ["open"] = r.IsOpen ? "true" : "false" },
            })
            .ToList();
    }

    /// <summary>The ticket number a search of one number asks for, with or without its "#"; null for anything else.</summary>
    internal static long? Number(SearchTerm term) =>
        term.Words is [var word] && long.TryParse(word.TrimStart('#'), NumberStyles.None, CultureInfo.InvariantCulture, out var number) && number > 0
            ? number
            : null;
}
