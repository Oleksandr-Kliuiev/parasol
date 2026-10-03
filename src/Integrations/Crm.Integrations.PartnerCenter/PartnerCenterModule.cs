using Crm.Integrations.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PartnerCenter;

public static class PartnerCenterModule
{
    public static IServiceCollection AddPartnerCenterIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<PartnerCenterOptions>().Bind(configuration.GetSection(PartnerCenterOptions.SectionName));
        services.AddHttpClient<PartnerCenterTokenProvider>();
        services.AddSingleton<PartnerCenterTokenProvider>(sp => new PartnerCenterTokenProvider(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(PartnerCenterTokenProvider)),
            sp.GetRequiredService<IOptions<PartnerCenterOptions>>(),
            sp.GetRequiredService<TimeProvider>()));
        services.AddTransient<PartnerCenterAuthHandler>();
        services.AddHttpClient<IPartnerCenterClient, PartnerCenterClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<PartnerCenterOptions>>().Value;
                client.BaseAddress = options.BaseUrl;
                client.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            })
            .AddHttpMessageHandler<PartnerCenterAuthHandler>()
            .AddStandardResilienceHandler(resilience =>
            {
                // Partner Center throttles with 429 and a Retry-After; the standard handler honours it.
                resilience.Retry.MaxRetryAttempts = 4;
                resilience.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(1);
            });

        services.AddHttpClient<IPartnerBillingClient, PartnerBillingClient>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<PartnerCenterOptions>>().Value.GraphBaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
            })
            .AddStandardResilienceHandler();

        services.AddScoped<IIntegrationAdapter, PartnerCenterAdapter>();
        services.AddScoped<PartnerCenterCustomerSyncJob>();
        services.AddScoped<PartnerCenterSubscriptionSyncJob>();
        services.AddScoped<PartnerCenterLicenseSyncJob>();
        services.AddScoped<PartnerBillingSyncJob>();
        return services;
    }
}
