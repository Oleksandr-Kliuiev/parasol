using Crm.Authorization;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;

namespace Crm.Integrations.Core.Parasol;

public static class CustomerIdentityEndpoints
{
    public static IEndpointRouteBuilder MapParasolCustomerIdentities(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/parasol").WithTags("Parasol");
        group.MapGet("/customers/{customerId:guid}/workspace", async (Guid customerId, AtlasWorkspaceReader reader,
                HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await reader.ReadAsync(customerId, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.ParasolAtlasRead);
        group.MapPost("/customer-identities/import", async (CustomerIdentityImport body, bool? dryRun, string? expectedSha256,
                CustomerIdentityService service, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await service.ImportAsync(body, dryRun ?? true, expectedSha256, ct)).ToHttpResult(Results.Ok);
            })
            .Validate<CustomerIdentityImport>()
            .RequirePermission(Permissions.IntegrationsManage)
            .RequireRateLimiting(RateLimitPolicies.Migration)
            .WithMetadata(new RequestSizeLimitAttribute(1_048_576));
        group.MapGet("/customers/{customerId:guid}/identity", async (Guid customerId, CustomerIdentityService service, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await service.GetAsync(customerId, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(Permissions.CustomersRead);
        return app;
    }
}
