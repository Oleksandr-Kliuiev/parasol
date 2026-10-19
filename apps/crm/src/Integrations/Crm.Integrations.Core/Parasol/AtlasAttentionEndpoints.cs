using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Integrations.Core.Parasol;

public static class AtlasAttentionEndpoints
{
    public static IServiceCollection AddParasolAtlasAttention(this IServiceCollection services)
    {
        services.AddScoped<IAtlasAttentionDirectory, AtlasAttentionDirectory>();
        services.AddScoped<IAtlasAttentionMappings, AtlasAttentionMappings>();
        services.AddScoped<IAtlasAttentionWorkspaces, AtlasAttentionWorkspaces>();
        services.AddScoped(provider => new AtlasAttentionReader(provider.GetRequiredService<ICurrentUser>(),
            provider.GetRequiredService<IAtlasAttentionDirectory>(), provider.GetRequiredService<IAtlasAttentionMappings>(),
            provider.GetRequiredService<IAtlasAttentionWorkspaces>(), provider.GetRequiredService<TimeProvider>()));
        return services;
    }

    public static IEndpointRouteBuilder MapParasolAtlasAttention(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/parasol/my-day/atlas-attention", async (AtlasAttentionReader reader, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return (await reader.ReadAsync(ct)).ToHttpResult(Results.Ok);
            }).WithTags("Parasol").RequirePermission(Permissions.CustomersRead).RequirePermission(Permissions.ParasolAtlasRead);
        return app;
    }
}
