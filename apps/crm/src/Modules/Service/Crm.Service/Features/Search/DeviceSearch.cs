using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Service.Features.Search;

/// <summary>
/// Devices in the global search: a customer's computer (M40 machine) by its name or by the name, serial number or logged-in user any
/// of its agents reported, and a word may name its customer ("dc01 fjord"). Current machines first, then those no longer reported;
/// a name equal to a word before one that starts with the first word. A hit opens the machine's card on the customer's Drift tab.
/// </summary>
internal sealed class DeviceSearchProvider(ServiceDbContext db, ICustomerSearchWords words, ICustomersApi customers) : ISearchProvider
{
    public string Group => "devices";

    public string RequiredPermission => Permissions.ServiceRead;

    public int Order => 22;

    public async Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken)
    {
        var named = await words.NamedAsync(term, cancellationToken);
        var first = term.Words[0];
        var rows = await db.Machines.AsNoTracking()
            .WhereWords(term, named,
                word => m => m.Name.Contains(word) || db.Devices.Any(d => d.MachineId == m.Id && (d.MachineName.Contains(word) ||
                    (d.SerialNumber != null && d.SerialNumber.Contains(word)) || (d.LastLoginUser != null && d.LastLoginUser.Contains(word)) ||
                    (d.LoggedInUsers != null && d.LoggedInUsers.Contains(word)))),
                ids => m => ids.Contains(m.OrganizationId))
            .OrderBy(m => m.RemovedAt == null ? 0 : 1)
            .ThenBy(m => term.Words.Contains(m.Name) ? 0 : m.Name.StartsWith(first) ? 1 : 2)
            .ThenBy(m => m.Name).ThenBy(m => m.Id)
            .Take(take)
            .Select(m => new { m.Id, m.OrganizationId, m.Name, m.Type, m.Os, m.RemovedAt })
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return [];
        }

        // What the agents of the page's machines reported, to say where a word was found: one read for the page.
        var ids = rows.Select(r => r.Id).ToList();
        var agents = (await db.Devices.AsNoTracking()
                .Where(d => d.MachineId != null && ids.Contains(d.MachineId.Value))
                .OrderBy(d => d.RemovedAt == null ? 0 : 1).ThenBy(d => d.FirstSeenAt).ThenBy(d => d.Id)
                .Select(d => new { MachineId = d.MachineId!.Value, Agent = new DeviceKeys(d.MachineName, d.SerialNumber, d.LastLoginUser, d.LoggedInUsers) })
                .ToListAsync(cancellationToken))
            .ToLookup(d => d.MachineId, d => d.Agent);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), cancellationToken);
        return rows.Select(r =>
            {
                var facts = new Dictionary<string, string> { ["type"] = r.Type.ToString() };
                if (r.Os is { Length: > 0 } os)
                {
                    facts["os"] = os;
                }

                if (r.RemovedAt is { } removed)
                {
                    facts["removedAt"] = removed.ToString("O", CultureInfo.InvariantCulture);
                }

                if (DeviceMatch.Find(term, r.Name, agents[r.Id]) is { } match)
                {
                    facts[match.Field] = match.Value;
                }

                return new SearchHit(r.Id, r.Name, organizations.GetValueOrDefault(r.OrganizationId), $"/organizations/{r.OrganizationId}?tab=drift&device={r.Id}")
                {
                    Facts = facts,
                };
            })
            .ToList();
    }
}

/// <summary>What one agent of a machine reported that a search looks in.</summary>
internal sealed record DeviceKeys(string MachineName, string? SerialNumber, string? LastLoginUser, string? LoggedInUsers);

/// <summary>
/// Where a word of the search was found when the machine's name does not show it: a serial number (<c>serial</c>), a user logged in at
/// the source's read (<c>loggedIn</c>), the user who last logged in (<c>lastLogin</c>) — the two facts the machine's card names apart —
/// or another name an agent of the machine goes by (<c>alias</c>). A word found nowhere named the customer, which the hit shows anyway.
/// </summary>
internal static class DeviceMatch
{
    public static (string Field, string Value)? Find(SearchTerm term, string name, IEnumerable<DeviceKeys> agents)
    {
        var reported = agents.ToList();
        foreach (var word in term.Words.Where(w => !Has(name, w)))
        {
            if (reported.Select(a => a.SerialNumber).FirstOrDefault(s => Has(s, word)) is { } serial)
            {
                return ("serial", serial);
            }

            if (reported.SelectMany(a => Users(a.LoggedInUsers)).FirstOrDefault(u => Has(u, word)) is { } loggedIn)
            {
                return ("loggedIn", loggedIn);
            }

            if (reported.Select(a => a.LastLoginUser).FirstOrDefault(u => Has(u, word)) is { } lastLogin)
            {
                return ("lastLogin", lastLogin);
            }

            if (reported.Select(a => a.MachineName).FirstOrDefault(n => Has(n, word)) is { } alias)
            {
                return ("alias", alias);
            }
        }

        return null;
    }

    private static bool Has(string? text, string word) => text?.Contains(word, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>The users as the source lists them (one, or several separated by commas or semicolons).</summary>
    private static string[] Users(string? users) =>
        users?.Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
}
