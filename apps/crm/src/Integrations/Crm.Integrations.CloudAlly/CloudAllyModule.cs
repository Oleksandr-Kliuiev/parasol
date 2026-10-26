using System.Net;
using System.Threading.RateLimiting;
using Crm.Infrastructure.DependencyInjection;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace Crm.Integrations.CloudAlly;

public static class CloudAllyModule
{
    public static IServiceCollection AddCloudAllyIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<CloudAllyOptions>().Bind(configuration.GetSection(CloudAllyOptions.SectionName))
            .Validate(options => Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.BaseUrl),
                "Integrations:CloudAlly:BaseUrl must be an https address (the client secret and the token travel with every call).")
            .ValidateOnStart();
        services.AddSingleton<CloudAllyTokenProvider>();
        services.AddTransient<CloudAllyAuthHandler>();
        // Signing in is safe to repeat: no redirects, and the standard resilience of a short call.
        services.AddHttpClient(CloudAllyTokenProvider.HttpClientName)
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddStandardResilienceHandler();

        services.AddHttpClient<ICloudAllyClient, CloudAllyClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<CloudAllyOptions>>().Value;
                client.BaseAddress = options.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
            })
            .AddHttpMessageHandler<CloudAllyAuthHandler>()
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("cloudally", (pipeline, context) =>
            {
                var options = context.ServiceProvider.GetRequiredService<IOptions<CloudAllyOptions>>().Value;
                // The retry is outermost, so every attempt, a retry included, takes a token from the limiter and has its own timeout.
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

        services.AddScoped<IIntegrationAdapter, CloudAllyAdapter>();
        services.AddScoped<CloudAllyLinkIndex>();
        services.AddScoped<CloudAllyAccountSyncJob>();
        services.AddScoped<CloudAllyBackupSyncJob>();
        services.AddScoped<CloudAllyBillSyncJob>();
        // M42: the actions on the one action path (M39.1), behind CloudAlly's own switches.
        services.AddScoped<IVendorActionGate, CloudAllyActionGate>();
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<CloudAllyRunAction>(sp, false));
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<CloudAllyRunAction>(sp, true));
        services.AddScoped<IVendorActionHandler, CloudAllyActivateAction>();
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<CloudAllyPauseAction>(sp, false));
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<CloudAllyPauseAction>(sp, true));
        services.AddScoped<IVendorActionHandler, CloudAllyDeactivateAction>();
        foreach (var way in Enum.GetValues<CloudAllyRestoreWay>())
        {
            services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<CloudAllyRestoreAction>(sp, way));
        }

        services.AddModuleServices(typeof(CloudAllyModule).Assembly);
        return services;
    }

    /// <summary>
    /// 429 means CloudAlly did not take the request, so any method may repeat it. A timeout, a dropped connection or a 5xx proves
    /// nothing about a write — a restore may have started — so only reads repeat on those; the action path settles a write's outcome.
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
