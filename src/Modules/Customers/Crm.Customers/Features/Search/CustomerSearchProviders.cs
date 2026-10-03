using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Search;

internal sealed class OrganizationSearchProvider(CustomersDbContext db) : ISearchProvider
{
    public string Group => "organizations";

    public string RequiredPermission => Permissions.CustomersRead;

    public int Order => 10;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var query = db.Organizations.AsNoTracking();
        if (term.IsNumeric)
        {
            query = query.Where(o =>
                (o.OrgNumber != null && o.OrgNumber.StartsWith(term.Digits)) ||
                (o.Phone != null && o.Phone.Replace(" ", string.Empty).Contains(term.Digits)));
        }
        else
        {
            // Every word must match the name, e-mail or a domain ("fjord it" finds "Fjord IT-Service AS").
            foreach (var word in term.Words)
            {
                var domain = word.TrimStart('@');
                query = query.Where(o => o.Name.Contains(word) || (o.Email != null && o.Email.Contains(word)) || o.Domains.Contains(domain));
            }
        }

        var rows = await query
            .OrderBy(o => o.Name.StartsWith(term.Text) ? 0 : 1).ThenBy(o => o.Name)
            .Take(take)
            .Select(o => new { o.Id, o.Name, o.OrgNumber, VisitCity = o.VisitAddress.City, PostalCity = o.PostalAddress.City })
            .ToListAsync(cancellationToken);

        return rows.Select(r => new SearchHit(
                r.Id,
                r.Name,
                JoinParts(FormatOrgNumber(r.OrgNumber), r.VisitCity ?? r.PostalCity),
                $"/organizations/{r.Id}"))
            .ToList();
    }

    private static string? FormatOrgNumber(string? value) =>
        value is { Length: 9 } ? $"{value[..3]} {value[3..6]} {value[6..]}" : value;

    internal static string? JoinParts(params string?[] parts)
    {
        var text = string.Join(" · ", parts.Where(p => !string.IsNullOrEmpty(p)));
        return text.Length == 0 ? null : text;
    }
}

internal sealed class ContactSearchProvider(CustomersDbContext db) : ISearchProvider
{
    public string Group => "contacts";

    public string RequiredPermission => Permissions.CustomersRead;

    public int Order => 20;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var query = db.Contacts.AsNoTracking();
        if (term.IsNumeric)
        {
            query = query.Where(c =>
                (c.Phone != null && c.Phone.Replace(" ", string.Empty).Contains(term.Digits)) ||
                (c.MobilePhone != null && c.MobilePhone.Replace(" ", string.Empty).Contains(term.Digits)));
        }
        else
        {
            foreach (var word in term.Words)
            {
                query = query.Where(c => c.FirstName.Contains(word) || c.LastName.Contains(word) || (c.Email != null && c.Email.Contains(word)));
            }
        }

        var rows = await query
            .OrderBy(c => c.LastName).ThenBy(c => c.FirstName)
            .Take(take)
            .Select(c => new
            {
                c.Id,
                c.FirstName,
                c.LastName,
                c.Email,
                Organization = db.OrganizationContacts
                    .Where(a => a.ContactId == c.Id && a.IsActive)
                    .OrderByDescending(a => a.IsPrimary)
                    .Join(db.Organizations, a => a.OrganizationId, o => o.Id, (a, o) => o.Name)
                    .FirstOrDefault(),
            })
            .ToListAsync(cancellationToken);

        return rows.Select(r => new SearchHit(
                r.Id,
                $"{r.FirstName} {r.LastName}".Trim(),
                OrganizationSearchProvider.JoinParts(r.Organization, r.Email),
                $"/contacts/{r.Id}"))
            .ToList();
    }
}
