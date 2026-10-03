using Crm.SharedKernel.Application;

namespace Crm.Web.Search;

public sealed record SearchGroup(string Group, IReadOnlyList<SearchHit> Items);

public sealed record SearchResponse(string Query, IReadOnlyList<SearchGroup> Groups);

/// <summary>Global search across modules (FR-GEN-01). Authorization is per provider, by the caller's permissions.</summary>
public static class SearchEndpoints
{
    public const string Route = "/api/v1/search";

    public static IEndpointRouteBuilder MapSearchEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(Route, async (string? q, int? take, IEnumerable<ISearchProvider> providers, ICurrentUser user, CancellationToken ct) =>
            {
                if (SearchTerm.Parse(q) is not { } term)
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        ["q"] = [$"Enter at least {SearchTerm.MinLength} characters."],
                    });
                }

                var limit = Math.Clamp(take ?? 5, 1, 20);
                var groups = new List<SearchGroup>();
                // Providers share the request's DbContext instances, so they run sequentially.
                foreach (var provider in providers.Where(p => user.HasPermission(p.RequiredPermission)).OrderBy(p => p.Order))
                {
                    var items = await provider.SearchAsync(term, limit, ct);
                    if (items.Count > 0)
                    {
                        groups.Add(new SearchGroup(provider.Group, items));
                    }
                }

                return Results.Ok(new SearchResponse(term.Text, groups));
            })
            .WithTags("Search");
        return app;
    }
}
