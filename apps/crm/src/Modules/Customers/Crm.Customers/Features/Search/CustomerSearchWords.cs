using Crm.Customers.Contracts;
using Crm.Customers.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;

namespace Crm.Customers.Features.Search;

/// <summary>
/// The organizations each word of a global search names, for the providers of other modules (devices, tickets, alerts, backups). One
/// small read per word, kept for the request: the host runs its providers one after another with the same term.
/// </summary>
internal sealed class CustomerSearchWords(CustomersDbContext db) : ICustomerSearchWords
{
    /// <summary>A word in the names of more organizations than this narrows nothing worth the list ("as").</summary>
    public const int MaxOrganizations = 100;

    private (string Text, IReadOnlyDictionary<string, IReadOnlyCollection<Guid>> Named)? _answer;

    public async Task<IReadOnlyDictionary<string, IReadOnlyCollection<Guid>>> NamedAsync(SearchTerm term, CancellationToken cancellationToken)
    {
        if (_answer is { } answer && answer.Text == term.Text)
        {
            return answer.Named;
        }

        var named = new Dictionary<string, IReadOnlyCollection<Guid>>(StringComparer.Ordinal);
        foreach (var word in term.Words.Distinct(StringComparer.Ordinal))
        {
            var ids = await db.Organizations.AsNoTracking()
                .Where(o => o.Name.Contains(word))
                .OrderBy(o => o.Id)
                .Select(o => o.Id)
                .Take(MaxOrganizations + 1)
                .ToListAsync(cancellationToken);
            if (ids.Count is > 0 and <= MaxOrganizations)
            {
                named[word] = ids;
            }
        }

        _answer = (term.Text, named);
        return named;
    }
}
