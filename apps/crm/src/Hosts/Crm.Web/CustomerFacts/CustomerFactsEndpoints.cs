using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Results;

namespace Crm.Web.CustomerFacts;

/// <summary>
/// The customer list's facts and attention view (UX 2026, В6). Both read only, both under <c>customers.read</c>; every part inside
/// is asked for only when the caller also holds that part's permission (<see cref="CustomerFactsService"/>).
/// </summary>
public static class CustomerFactsEndpoints
{
    public const string FactsRoute = "/api/v1/customers/organizations/facts";

    public const string AttentionRoute = "/api/v1/customers/organizations/attention";

    public static IEndpointRouteBuilder MapCustomerFactsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet(FactsRoute, async (string? ids, CustomerFactsService service, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return CustomerFactsRequest.ParseIds(ids) is { } organizationIds
                    ? Results.Ok(await service.GetFactsAsync(organizationIds, ct))
                    : Error.Validation(CustomerFactsRequest.InvalidCode, CustomerFactsRequest.InvalidMessage).ToProblem();
            })
            .RequirePermission(Permissions.CustomersRead)
            .WithTags("Customers");

        app.MapGet(AttentionRoute, async (bool? mine, CustomerFactsService service, HttpResponse response, CancellationToken ct) =>
            {
                response.Headers.CacheControl = "no-store";
                return Results.Ok(await service.GetAttentionAsync(mine ?? false, ct));
            })
            .RequirePermission(Permissions.CustomersRead)
            .WithTags("Customers");

        return app;
    }
}
