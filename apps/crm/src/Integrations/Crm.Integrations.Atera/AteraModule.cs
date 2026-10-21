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
        services.AddOptions<AteraOptions>().Bind(configuration.GetSection(AteraOptions.SectionName))
            .Validate(options => Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.BaseUrl), "Integrations:Atera:BaseUrl must be an https address (the API key travels with every call).")
            .ValidateOnStart();
        services.AddHttpClient<IAteraClient, AteraClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<AteraOptions>>().Value;
                client.BaseAddress = options.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
                AteraAuthentication.Apply(client.DefaultRequestHeaders, options);
            })
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("atera", (pipeline, context) =>
            {
                var options = context.ServiceProvider.GetRequiredService<IOptions<AteraOptions>>().Value;
                // Order matters: the retry is outermost so that every attempt, a retry included, takes a token from the limiter
                // and runs under its own timeout (DEV-19).
                pipeline.AddRetry(new HttpRetryStrategyOptions
                {
                    MaxRetryAttempts = 4,
                    UseJitter = true,
                    BackoffType = DelayBackoffType.Exponential,
                    Delay = options.RetryDelay,
                    ShouldRetryAfterHeader = true,
                    ShouldHandle = args => ValueTask.FromResult(ShouldRetry(args.Context.GetRequestMessage()?.Method, args.Outcome.Result?.StatusCode, args.Outcome.Exception)),
                });
                pipeline.AddRateLimiter(new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
                {
                    TokenLimit = Math.Max(1, options.RequestsPerMinute / 6),
                    TokensPerPeriod = Math.Max(1, options.RequestsPerMinute / 6),
                    ReplenishmentPeriod = TimeSpan.FromSeconds(10),
                    QueueLimit = 100_000,
                    AutoReplenishment = true,
                }));
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

    /// <summary>
    /// 429 means Atera did not process the request, so it is safe to repeat for any method. Atera has no idempotency key: a
    /// timeout, a dropped connection or a 5xx proves nothing about a write (the ticket may exist), so only reads repeat on those;
    /// a write's outcome is settled by the handler's search for its marker (DEV-19).
    /// </summary>
    internal static bool ShouldRetry(HttpMethod? method, HttpStatusCode? status, Exception? exception)
    {
        if (status == HttpStatusCode.TooManyRequests)
        {
            return true;
        }

        var isRead = method == HttpMethod.Get || method == HttpMethod.Head;
        return isRead && (exception is HttpRequestException or TimeoutException or Polly.Timeout.TimeoutRejectedException || (int?)status >= 500);
    }
}
