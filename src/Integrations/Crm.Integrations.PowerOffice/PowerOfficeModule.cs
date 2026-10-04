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
                pipeline.AddRateLimiter(new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
                {
                    TokenLimit = options.RequestsPerSecond,
                    TokensPerPeriod = options.RequestsPerSecond,
                    ReplenishmentPeriod = TimeSpan.FromSeconds(1),
                    QueueLimit = 10_000,
                    AutoReplenishment = true,
                }));
                pipeline.AddRetry(new HttpRetryStrategyOptions
                {
                    MaxRetryAttempts = 4,
                    UseJitter = true,
                    Delay = TimeSpan.FromSeconds(1),
                    // 429/503 mean "not processed" and are safe to repeat for any method; other failures only for reads.
                    ShouldHandle = args => ValueTask.FromResult(
                        args.Outcome.Result?.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.ServiceUnavailable ||
                        (args.Outcome.Result?.RequestMessage?.Method == HttpMethod.Get &&
                         (args.Outcome.Exception is HttpRequestException or TimeoutException || (int?)args.Outcome.Result?.StatusCode >= 500))),
                });
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
        services.AddModuleServices(typeof(PowerOfficeModule).Assembly);
        return services;
    }
}
