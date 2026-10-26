using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Integrations.Core.Readiness;

public static class ConnectionStatusEndpoints
{
    public static IServiceCollection AddConnectionStatus(this IServiceCollection services)
    {
        services.AddScoped<IConnectionStatusStore, ConnectionStatusStore>();
        services.AddScoped(provider => new ConnectionStatusReader(provider.GetRequiredService<ICurrentUser>(),
            provider.GetRequiredService<IConnectionCatalog>(), provider.GetRequiredService<IConnectionStatusStore>(),
            provider.GetRequiredService<TimeProvider>()));
        return services;
    }

    public static IEndpointRouteBuilder MapConnectionStatus(this IEndpointRouteBuilder app)
    {
        // The connections page. GET /api/v1/integrations/status is the administration's list of adapters, records and queues.
        app.MapGet("/api/v1/integrations/connections", async (ConnectionStatusReader reader, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await reader.ReadAsync(ct)).ToHttpResult(Results.Ok);
            }).WithTags("Integrations").RequirePermission(Permissions.IntegrationsManage);
        return app;
    }
}
