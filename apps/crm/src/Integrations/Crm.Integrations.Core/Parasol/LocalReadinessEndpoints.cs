using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public static class LocalReadinessEndpoints
{
    public static IServiceCollection AddParasolLocalReadiness(this IServiceCollection services)
    {
        services.AddScoped<ILocalReadinessStoredState, LocalReadinessStoredState>();
        services.AddScoped<ILocalMappingSource, LocalReadinessMappingSource>();
        services.AddScoped<ILocalReadinessMappings, LocalReadinessMappings>();
        services.AddScoped(provider => new LocalReadinessReader(provider.GetRequiredService<ICurrentUser>(),
            provider.GetRequiredService<IOptions<AtlasWorkspaceOptions>>(), provider.GetRequiredService<ILocalReadinessFlags>(),
            provider.GetRequiredService<ILocalReadinessStoredState>(), provider.GetRequiredService<ILocalReadinessMappings>(), provider.GetRequiredService<TimeProvider>()));
        return services;
    }

    public static IEndpointRouteBuilder MapParasolLocalReadiness(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/parasol/local-readiness", async (LocalReadinessReader reader, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await reader.ReadAsync(ct)).ToHttpResult(Results.Ok);
            }).WithTags("Parasol").RequireAuthorization(); // Reader enforces the OR gate and each section's permission.
        return app;
    }
}
