namespace Crm.SharedKernel.Application;

/// <summary>One result in the global search (FR-GEN-01). <see cref="Url"/> is the SPA route of the record.</summary>
public sealed record SearchHit(Guid Id, string Title, string? Subtitle, string Url);

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
