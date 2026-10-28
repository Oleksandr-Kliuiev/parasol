using Crm.SharedKernel.Application;

namespace Crm.Web.Search;

/// <summary>One group of hits; <paramref name="More"/> says the group found more than it shows, so the interface asks for more words.</summary>
public sealed record SearchGroup(string Group, IReadOnlyList<SearchHit> Items, bool More);

public sealed record SearchResponse(string Query, IReadOnlyList<SearchGroup> Groups);

/// <summary>Global search across modules (FR-GEN-01). Authorization is per provider, by the caller's permissions.</summary>
public static class SearchEndpoints
{
    public const string Route = "/api/v1/search";

    public static IEndpointRouteBuilder MapSearchEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(Route, async (string? q, int? take, string? groups, IEnumerable<ISearchProvider> providers, ICurrentUser user, CancellationToken ct) =>
            {
                if (SearchTerm.Parse(q) is not { } term)
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        ["q"] = [$"Enter at least {SearchTerm.MinLength} characters."],
                    });
                }

                var limit = Math.Clamp(take ?? 5, 1, 20);
                // A picker that needs one kind of record names its group, so the others are not searched for nothing.
                var wanted = groups?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);
                var found = new List<SearchGroup>();
                // Providers share the request's DbContext instances, so they run sequentially.
                foreach (var provider in providers
                             .Where(p => user.HasPermission(p.RequiredPermission) && (wanted is not { Count: > 0 } || wanted.Contains(p.Group)))
                             .OrderBy(p => p.Order))
                {
                    // One more than is shown says whether there are more, without counting them all (DEV-12: never a silent cut).
                    var items = await provider.SearchAsync(term, limit + 1, ct);
                    if (items.Count > 0)
                    {
                        found.Add(new SearchGroup(provider.Group, items.Take(limit).ToList(), items.Count > limit));
                    }
                }

                return Results.Ok(new SearchResponse(term.Text, found));
            })
            .WithTags("Search");
        return app;
    }
}
