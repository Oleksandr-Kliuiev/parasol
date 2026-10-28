using System.Linq.Expressions;

namespace Crm.SharedKernel.Application;

/// <summary>One result in the global search (FR-GEN-01). <see cref="Url"/> is the SPA route of the record.</summary>
public sealed record SearchHit(Guid Id, string Title, string? Subtitle, string Url)
{
    /// <summary>
    /// What the interface words in the reader's language beside the title (operations records: a device's type, a ticket's status, an
    /// alert's severity, the field a word was found in): codes and plain values under keys the group names, never a sentence. Null
    /// when the title and subtitle say everything.
    /// </summary>
    public IReadOnlyDictionary<string, string>? Facts { get; init; }
}

/// <summary>
/// Contributed by a module for one record type. The host runs every provider whose permission the caller holds,
/// so a module's records never leak into search results for users who cannot read them.
/// </summary>
public interface ISearchProvider
{
    /// <summary>Stable group key used by the UI, e.g. <c>organizations</c>.</summary>
    string Group { get; }

    string RequiredPermission { get; }

    /// <summary>Display order of the group.</summary>
    int Order { get; }

    Task<IReadOnlyList<SearchHit>> SearchAsync(SearchTerm term, int take, CancellationToken cancellationToken);
}

/// <summary>Parsed search input: trimmed text, lower-cased words and the digits (for org numbers and phones).</summary>
public sealed record SearchTerm(string Text, IReadOnlyList<string> Words, string Digits)
{
    public const int MinLength = 2;

    public static SearchTerm? Parse(string? input)
    {
        var text = input?.Trim() ?? string.Empty;
        if (text.Length < MinLength)
        {
            return null;
        }

        var words = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(w => w.ToLowerInvariant())
            .Take(5)
            .ToList();
        var digits = new string(text.Where(char.IsAsciiDigit).ToArray());
        return new SearchTerm(text, words, digits);
    }

    /// <summary>True when the input is essentially a number (org number, phone), ignoring spaces and a leading plus.</summary>
    public bool IsNumeric => Digits.Length >= 3 && Text.All(c => char.IsAsciiDigit(c) || c is ' ' or '+' or '-');
}

/// <summary>
/// The search of records that belong to a customer (devices, tickets, alerts, backups): every word must be found in the record's own
/// fields or, for a word that names customers, in the name of the record's customer, so "dc01 fjord" finds Fjord's DC01. A customer's
/// name alone never lists all of its records: at least one word must be found in the record itself.
/// </summary>
public static class CustomerRecordSearch
{
    /// <param name="customers">The organizations each word names (only the words that name some).</param>
    /// <param name="own">Whether a word is found in the record's own fields.</param>
    /// <param name="ofCustomers">Whether the record belongs to one of the organizations.</param>
    public static IQueryable<T> WhereWords<T>(
        this IQueryable<T> query,
        SearchTerm term,
        IReadOnlyDictionary<string, IReadOnlyCollection<Guid>> customers,
        Func<string, Expression<Func<T, bool>>> own,
        Func<IReadOnlyCollection<Guid>, Expression<Func<T, bool>>> ofCustomers)
    {
        foreach (var word in term.Words)
        {
            query = query.Where(customers.TryGetValue(word, out var named) ? Either(own(word), ofCustomers(named)) : own(word));
        }

        // A word that names no customer is already found in the record; only when every word names one may none of them be.
        if (term.Words.All(customers.ContainsKey))
        {
            query = query.Where(term.Words.Select(own).Aggregate(Either));
        }

        return query;
    }

    private static Expression<Func<T, bool>> Either<T>(Expression<Func<T, bool>> first, Expression<Func<T, bool>> second) =>
        Expression.Lambda<Func<T, bool>>(
            Expression.OrElse(first.Body, new Rebind(second.Parameters[0], first.Parameters[0]).Visit(second.Body)), first.Parameters);

    /// <summary>Lets the body of one lambda speak of the other's parameter, so the two join into one condition.</summary>
    private sealed class Rebind(ParameterExpression from, ParameterExpression to) : ExpressionVisitor
    {
        protected override Expression VisitParameter(ParameterExpression node) => node == from ? to : base.VisitParameter(node);
    }
}
