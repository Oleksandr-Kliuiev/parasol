using Crm.SharedKernel.Application;

namespace Crm.Customers.Contracts;

/// <summary>
/// Which organizations each word of a global search names (FR-GEN-01), so a module whose records belong to a customer lets such a
/// word narrow them (<see cref="CustomerRecordSearch"/>: "dc01 fjord" finds Fjord's DC01). Answered once per request: every
/// provider of the request asks with the same term.
/// </summary>
public interface ICustomerSearchWords
{
    /// <summary>
    /// The ids of the organizations whose name contains each word; a word that names none, or so many that it narrows nothing ("as"),
    /// is left out.
    /// </summary>
    Task<IReadOnlyDictionary<string, IReadOnlyCollection<Guid>>> NamedAsync(SearchTerm term, CancellationToken cancellationToken);
}
