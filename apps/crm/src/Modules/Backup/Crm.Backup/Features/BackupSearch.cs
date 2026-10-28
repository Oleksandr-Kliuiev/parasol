using System.Security.Cryptography;
using System.Text;
using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Backup.Persistence;
using Crm.Customers.Contracts;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Backup.Features;

/// <summary>
/// Backups in the global search: the people (mailbox, OneDrive) and the sites and teams in a customer's backup, by their name or
/// address, and a word may name the customer ("kari fjord"). One hit per name and customer, with the services it is backed up in, so
/// a person's mailbox and OneDrive are one hit. A hit opens the customer's Sikkerhetskopi tab with its list narrowed to that name.
/// </summary>
internal sealed class BackupSearchProvider(BackupDbContext db, ICustomerSearchWords words, ICustomersApi customers) : ISearchProvider
{
    /// <summary>The services in the order the tab lists them, as the hit names them.</summary>
    private static readonly BackupService[] Services = [BackupService.Mail, BackupService.OneDrive, BackupService.SharePoint, BackupService.Teams, BackupService.Other];

    public string Group => "backup";

    public string RequiredPermission => Permissions.ServiceRead;

    public int Order => 28;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var named = await words.NamedAsync(term, cancellationToken);
        var entities = from e in db.Entities
                       join t in db.Tasks on e.TaskId equals t.Id
                       join a in db.Accounts on t.AccountId equals a.Id
                       select new { e.Name, e.FullName, a.OrganizationId, t.Service };
        var rows = await entities.AsNoTracking()
            .WhereWords(term, named,
                word => x => x.Name.Contains(word) || (x.FullName != null && x.FullName.Contains(word)),
                ids => x => ids.Contains(x.OrganizationId))
            .GroupBy(x => new { x.OrganizationId, x.Name })
            .Select(g => new
            {
                g.Key.OrganizationId,
                g.Key.Name,
                FullName = g.Max(x => x.FullName),
                Mail = g.Max(x => x.Service == BackupService.Mail ? 1 : 0),
                OneDrive = g.Max(x => x.Service == BackupService.OneDrive ? 1 : 0),
                SharePoint = g.Max(x => x.Service == BackupService.SharePoint ? 1 : 0),
                Teams = g.Max(x => x.Service == BackupService.Teams ? 1 : 0),
                Other = g.Max(x => x.Service == BackupService.Other ? 1 : 0),
            })
            .OrderBy(g => g.FullName ?? g.Name).ThenBy(g => g.Name).ThenBy(g => g.OrganizationId)
            .Take(take)
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return [];
        }

        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), cancellationToken);
        return rows.Select(r =>
            {
                int[] flags = [r.Mail, r.OneDrive, r.SharePoint, r.Teams, r.Other];
                var facts = new Dictionary<string, string>
                {
                    ["services"] = string.Join(',', Services.Where((_, i) => flags[i] == 1)),
                };
                // A person is named by their name, and their address says which of several namesakes it is; a site has its name only.
                var person = r.FullName is { Length: > 0 } fullName && !string.Equals(fullName, r.Name, StringComparison.OrdinalIgnoreCase);
                if (person)
                {
                    facts["address"] = r.Name;
                }

                return new SearchHit(
                    KeyOf(r.OrganizationId, r.Name), person ? r.FullName! : r.Name, organizations.GetValueOrDefault(r.OrganizationId),
                    $"/organizations/{r.OrganizationId}?tab=backup&search={Uri.EscapeDataString(r.Name)}")
                {
                    Facts = facts,
                };
            })
            .ToList();
    }

    /// <summary>
    /// The hit's id: a person or site is several entities (one per service), so the id is made from the customer and the name. It is
    /// stable from search to search and names no stored row.
    /// </summary>
    internal static Guid KeyOf(Guid organizationId, string name) =>
        new(SHA256.HashData(Encoding.UTF8.GetBytes($"{organizationId:N}|{name.ToLowerInvariant()}")).AsSpan(0, 16));
}
