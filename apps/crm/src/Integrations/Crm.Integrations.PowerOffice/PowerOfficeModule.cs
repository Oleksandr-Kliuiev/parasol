using System.Net;
using System.Threading.RateLimiting;
using Crm.Billing.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.Integrations.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace Crm.Integrations.PowerOffice;

public static class PowerOfficeModule
{
    public static IServiceCollection AddPowerOfficeIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<PowerOfficeOptions>()
            .Bind(configuration.GetSection(PowerOfficeOptions.SectionName))
            .Validate(
                options => PowerOfficeOptions.FitsDeployment(options, configuration["Deployment:Environment"]),
                "Integrations:PowerOffice:Environment does not fit Deployment:Environment: prod uses Production, test uses Demo.")
            .Validate(
                options => Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.EffectiveBaseUrl) && Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.EffectiveTokenUrl),
                "Integrations:PowerOffice:BaseUrl and TokenUrl must be https addresses.")
            .ValidateOnStart();
        services.AddSingleton<PowerOfficeTokenProvider>();
        services.AddTransient<PowerOfficeAuthHandler>();
        services.AddHttpClient(PowerOfficeTokenProvider.HttpClientName)
            .AddStandardResilienceHandler();

        services.AddHttpClient<IPowerOfficeClient, PowerOfficeClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<PowerOfficeOptions>>().Value;
                client.BaseAddress = options.EffectiveBaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
                client.DefaultRequestHeaders.UserAgent.ParseAdd(options.UserAgent);
            })
            .AddHttpMessageHandler<PowerOfficeAuthHandler>()
            .AddResilienceHandler("poweroffice", (pipeline, context) =>
            {
                var options = context.ServiceProvider.GetRequiredService<IOptions<PowerOfficeOptions>>().Value;
                // Order matters: the retry is outermost so that every attempt, a retry included, takes a token from the limiter
                // and runs under its own timeout.
                pipeline.AddRetry(new HttpRetryStrategyOptions
                {
                    MaxRetryAttempts = 4,
                    UseJitter = true,
                    Delay = options.RetryDelay,
                    ShouldHandle = args => ValueTask.FromResult(ShouldRetry(args.Context.GetRequestMessage()?.Method, args.Outcome.Result?.StatusCode, args.Outcome.Exception)),
                });
                pipeline.AddRateLimiter(new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
                {
                    TokenLimit = options.RequestsPerSecond,
                    TokensPerPeriod = options.RequestsPerSecond,
                    ReplenishmentPeriod = TimeSpan.FromSeconds(1),
                    QueueLimit = 10_000,
                    AutoReplenishment = true,
                }));
                pipeline.AddTimeout(TimeSpan.FromSeconds(60));
            });

        services.AddScoped<IIntegrationAdapter, PowerOfficeAdapter>();
        services.AddScoped<IOutboundHandler, PowerOfficeCreateCustomerHandler>();
        services.AddScoped<IOutboundHandler, PowerOfficeUpdateCustomerHandler>();
        services.AddScoped<IOutboundHandler, PowerOfficeSyncContactPersonHandler>();
        services.AddScoped<IOutboundHandler, PowerOfficeCreateSalesOrderHandler>();
        services.AddScoped<IBillingTargetSystem, PowerOfficeBillingTarget>();
        services.AddScoped<PowerOfficeCustomerSyncJob>();
        services.AddScoped<PowerOfficeContactPersonSyncJob>();
        services.AddScoped<PowerOfficeProductSyncJob>();
        services.AddScoped<PowerOfficeInvoiceSyncJob>();
        services.AddScoped<PowerOfficeLedgerSyncJob>();
        services.AddScoped<PowerOfficePdfSyncJob>();
        services.AddModuleServices(typeof(PowerOfficeModule).Assembly);
        return services;
    }

    /// <summary>
    /// 429 means PowerOffice did not process the request and is safe to repeat for any method. A 5xx (503 included), a timeout
    /// or a dropped connection proves nothing about a write — the order or customer may exist — so only reads repeat on those;
    /// a write's outcome is settled by the handler's lookup by external reference (ADR-013).
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
