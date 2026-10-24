using System.Net;
using Crm.Integrations.Core;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;
using Polly;

namespace Crm.Integrations.PartnerCenter;

public static class PartnerCenterModule
{
    public static IServiceCollection AddPartnerCenterIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<PartnerCenterOptions>().Bind(configuration.GetSection(PartnerCenterOptions.SectionName))
            .Validate(
                options => Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.BaseUrl) && Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.GraphBaseUrl)
                           && Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.EffectiveTokenUrl),
                "Integrations:PartnerCenter:BaseUrl, GraphBaseUrl and TokenUrl must be https addresses.")
            .ValidateOnStart();
        services.AddHttpClient<PartnerCenterTokenProvider>().ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects);
        services.AddSingleton<PartnerCenterTokenProvider>(sp => new PartnerCenterTokenProvider(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(nameof(PartnerCenterTokenProvider)),
            sp.GetRequiredService<IOptions<PartnerCenterOptions>>(),
            sp.GetRequiredService<TimeProvider>()));
        services.AddTransient<PartnerCenterAuthHandler>();
        services.AddHttpClient<IPartnerCenterClient, PartnerCenterClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<PartnerCenterOptions>>().Value;
                client.BaseAddress = options.BaseUrl;
                client.Timeout = options.TotalTimeout + TimeSpan.FromSeconds(30);
                client.DefaultRequestHeaders.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("application/json"));
            })
            .AddHttpMessageHandler<PartnerCenterAuthHandler>()
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("partnercenter", Configure);

        services.AddHttpClient<IPartnerBillingClient, PartnerBillingClient>((sp, client) =>
            {
                var options = sp.GetRequiredService<IOptions<PartnerCenterOptions>>().Value;
                client.BaseAddress = options.GraphBaseUrl;
                client.Timeout = options.TotalTimeout + TimeSpan.FromSeconds(30);
            })
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("partnercenter-billing", Configure);

        services.AddScoped<IIntegrationAdapter, PartnerCenterAdapter>();
        services.AddScoped<PartnerCenterCustomerSyncJob>();
        services.AddScoped<PartnerCenterSubscriptionSyncJob>();
        services.AddScoped<PartnerCenterLicenseSyncJob>();
        services.AddScoped<PartnerBillingSyncJob>();
        return services;
    }

    /// <summary>
    /// Explicit timeouts instead of the standard 10 s per attempt and 30 s per call: a page of customers or a billing blob can
    /// take longer, and a read that is cut off retries and then fails the run (DEV-19). The order is total timeout, retry (which
    /// honours Retry-After on 429), then the timeout of a single attempt.
    /// </summary>
    private static void Configure(ResiliencePipelineBuilder<HttpResponseMessage> pipeline, ResilienceHandlerContext context)
    {
        var options = context.ServiceProvider.GetRequiredService<IOptions<PartnerCenterOptions>>().Value;
        pipeline.AddTimeout(options.TotalTimeout);
        pipeline.AddRetry(new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 4,
            UseJitter = true,
            BackoffType = DelayBackoffType.Exponential,
            Delay = options.RetryDelay,
            ShouldRetryAfterHeader = true,
            ShouldHandle = args => ValueTask.FromResult(ShouldRetry(args.Context.GetRequestMessage()?.Method, args.Outcome.Result?.StatusCode, args.Outcome.Exception)),
        });
        pipeline.AddTimeout(options.RequestTimeout);
    }

    /// <summary>Throttling is repeated for any method; transient failures only for reads (the billing export starts with a POST).</summary>
    internal static bool ShouldRetry(HttpMethod? method, HttpStatusCode? status, Exception? exception)
    {
        if (status == HttpStatusCode.TooManyRequests)
        {
            return true;
        }

        var isRead = method == HttpMethod.Get || method == HttpMethod.Head;
        return isRead && (exception is HttpRequestException or TimeoutException or Polly.Timeout.TimeoutRejectedException || status is HttpStatusCode.RequestTimeout || (int?)status >= 500);
    }
}
