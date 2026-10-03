using System.Net;
using System.Threading.RateLimiting;
using Crm.Infrastructure.DependencyInjection;
using Crm.Integrations.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace Crm.Integrations.Atera;

public static class AteraModule
{
    public static IServiceCollection AddAteraIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<AteraOptions>().Bind(configuration.GetSection(AteraOptions.SectionName));
        services.AddHttpClient<IAteraClient, AteraClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<AteraOptions>>().Value;
                client.BaseAddress = options.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
                if (!string.IsNullOrWhiteSpace(options.ApiKey))
                {
                    client.DefaultRequestHeaders.Add("X-API-KEY", options.ApiKey);
                }
            })
            .AddResilienceHandler("atera", (pipeline, context) =>
            {
                var options = context.ServiceProvider.GetRequiredService<IOptions<AteraOptions>>().Value;
                pipeline.AddRateLimiter(new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
                {
                    TokenLimit = Math.Max(1, options.RequestsPerMinute / 6),
                    TokensPerPeriod = Math.Max(1, options.RequestsPerMinute / 6),
                    ReplenishmentPeriod = TimeSpan.FromSeconds(10),
                    QueueLimit = 100_000,
                    AutoReplenishment = true,
                }));
                pipeline.AddRetry(new HttpRetryStrategyOptions
                {
                    MaxRetryAttempts = 4,
                    UseJitter = true,
                    Delay = TimeSpan.FromSeconds(2),
                    // Creates are never retried on server errors: Atera has no idempotency key.
                    ShouldHandle = args => ValueTask.FromResult(
                        args.Outcome.Result?.StatusCode == HttpStatusCode.TooManyRequests ||
                        (args.Outcome.Result?.RequestMessage?.Method == HttpMethod.Get &&
                         (args.Outcome.Exception is HttpRequestException or TimeoutException || (int?)args.Outcome.Result?.StatusCode >= 500))),
                });
                pipeline.AddTimeout(TimeSpan.FromSeconds(60));
            });

        services.AddScoped<IIntegrationAdapter, AteraAdapter>();
        services.AddScoped<IOutboundHandler, AteraCreateCustomerHandler>();
        services.AddScoped<IOutboundHandler, AteraUpdateCustomerHandler>();
        services.AddScoped<IOutboundHandler, AteraSetSlaHandler>();
        services.AddScoped<IOutboundHandler, AteraCreateTicketHandler>();
        services.AddScoped<AteraLinkIndex>();
        services.AddScoped<AteraTicketSyncJob>();
        services.AddScoped<AteraWorkHoursSyncJob>();
        services.AddScoped<AteraAgentSyncJob>();
        services.AddScoped<AteraAlertSyncJob>();
        services.AddScoped<AteraCustomerSyncJob>();
        services.AddScoped<AteraContactSyncJob>();
        services.AddModuleServices(typeof(AteraModule).Assembly);
        return services;
    }
}
