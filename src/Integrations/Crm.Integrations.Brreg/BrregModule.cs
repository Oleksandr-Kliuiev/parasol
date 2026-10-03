using System.Threading.RateLimiting;
using Crm.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace Crm.Integrations.Brreg;

public sealed class BrregOptions
{
    public const string SectionName = "Integrations:Brreg";

    public Uri BaseUrl { get; set; } = new("https://data.brreg.no/enhetsregisteret/api/");

    /// <summary>Courtesy limit towards the open API (docs/05-integrations.md §5).</summary>
    public int RequestsPerSecond { get; set; } = 5;
}

public static class BrregModule
{
    public static IServiceCollection AddBrregIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<BrregOptions>().Bind(configuration.GetSection(BrregOptions.SectionName));

        services.AddHttpClient<IBrregClient, BrregClient>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<BrregOptions>>().Value.BaseUrl;
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
                client.DefaultRequestHeaders.UserAgent.ParseAdd("VardaheiCRM/2.0");
            })
            .AddResilienceHandler("brreg", (pipeline, context) =>
            {
                var options = context.ServiceProvider.GetRequiredService<IOptions<BrregOptions>>().Value;
                pipeline.AddRateLimiter(new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
                {
                    TokenLimit = options.RequestsPerSecond,
                    TokensPerPeriod = options.RequestsPerSecond,
                    ReplenishmentPeriod = TimeSpan.FromSeconds(1),
                    QueueLimit = 100,
                    AutoReplenishment = true,
                }));
                pipeline.AddRetry(new HttpRetryStrategyOptions { MaxRetryAttempts = 3, UseJitter = true });
                pipeline.AddTimeout(TimeSpan.FromSeconds(10));
            });

        services.AddScoped<BrregRegistryCheckJob>();
        return services;
    }

    public static IEndpointRouteBuilder MapBrregEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/integrations/brreg").WithTags("Brreg");

        group.MapGet("/organizations/{orgNumber}", async (string orgNumber, IBrregClient client, CancellationToken ct) =>
            {
                var digits = new string(orgNumber.Where(char.IsAsciiDigit).ToArray());
                if (digits.Length != 9)
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]> { ["orgNumber"] = ["Organization number must be 9 digits."] });
                }

                var lookup = await client.GetAsync(digits, ct);
                return Results.Ok(lookup);
            })
            .RequirePermission(Permissions.CustomersRead);

        group.MapGet("/organizations", async (string name, int? size, IBrregClient client, CancellationToken ct) =>
                string.IsNullOrWhiteSpace(name) || name.Trim().Length < 2
                    ? Results.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Enter at least 2 characters."] })
                    : Results.Ok(await client.SearchAsync(name.Trim(), size ?? 10, ct)))
            .RequirePermission(Permissions.CustomersRead);

        return app;
    }
}
