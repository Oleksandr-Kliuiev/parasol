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

namespace Crm.Integrations.Huntress;

public static class HuntressModule
{
    /// <summary>
    /// The window Parasoll counts requests in. Huntress allows 60 requests in any 60 seconds of a sliding window; a request leaves
    /// this window only once its 10-second segment is a full minute old, so the reads and the actions together never exceed what
    /// Huntress counts.
    /// </summary>
    internal static readonly TimeSpan Window = TimeSpan.FromSeconds(70);

    public static IServiceCollection AddHuntressIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<HuntressOptions>().Bind(configuration.GetSection(HuntressOptions.SectionName))
            .Validate(options => Crm.SharedKernel.Text.WebUrl.IsSecureEndpoint(options.BaseUrl), "Integrations:Huntress:BaseUrl must be an https address (the API key travels with every call).")
            .Validate(options => options.ReadRequestsPerMinute >= 1 && options.ActionRequestsPerMinute >= 1 &&
                                 options.ReadRequestsPerMinute + options.ActionRequestsPerMinute <= options.AccountRequestsPerMinute,
                "Integrations:Huntress: the read and action budgets are at least 1 each and together at most the account's requests a minute.")
            .Validate(options => options.AccountRequestsPerMinute <= 60 || !options.BaseUrl.Host.EndsWith("huntress.io", StringComparison.OrdinalIgnoreCase),
                "Integrations:Huntress: Huntress allows an account 60 requests a minute; only a stand-in may be given more.")
            .ValidateOnStart();

        // M41: one client, two budgets. The scheduled reads spend 45 requests a minute, the actions people ask for 15 (M38), each
        // in its own limiter, so a long read never keeps an isolation waiting.
        services.AddHttpClient<IHuntressClient, HuntressClient>(Configure)
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("huntress-reads", (pipeline, context) => Pipeline(pipeline, context.ServiceProvider, o => o.ReadRequestsPerMinute));
        services.AddHttpClient<IHuntressActionClient, HuntressClient>(Configure)
            .ConfigurePrimaryHttpMessageHandler(ProviderHttp.NoRedirects)
            .AddResilienceHandler("huntress-actions", (pipeline, context) => Pipeline(pipeline, context.ServiceProvider, o => o.ActionRequestsPerMinute));

        services.AddScoped<IIntegrationAdapter, HuntressAdapter>();
        services.AddScoped<HuntressLinkIndex>();
        services.AddScoped<HuntressOrganizationSyncJob>();
        services.AddScoped<HuntressAgentSyncJob>();
        services.AddScoped<HuntressAlertSyncJob>();
        services.AddScoped<HuntressReportSyncJob>();
        services.AddScoped<HuntressReadBack>();
        // The actions (M41) on the one action path of M39.1, behind Huntress's own switches.
        services.AddScoped<IVendorActionGate, HuntressActionGate>();
        services.AddScoped<IVendorActionHandler, HuntressApproveAction>();
        services.AddScoped<IVendorActionHandler, HuntressRejectAction>();
        services.AddScoped<IVendorActionHandler, HuntressStepAction>();
        services.AddScoped<IVendorActionHandler, HuntressIncidentResolveAction>();
        services.AddScoped<IVendorActionHandler, HuntressCommentAction>();
        services.AddScoped<IVendorActionHandler, HuntressEscalationResolveAction>();
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<HuntressIsolationAction>(sp, true));
        services.AddScoped<IVendorActionHandler>(sp => ActivatorUtilities.CreateInstance<HuntressIsolationAction>(sp, false));
        services.AddScoped<IVendorActionHandler, HuntressUninstallAction>();
        // M43: the customer's organization created from the "Connect services" wizard, found by its key before and after.
        services.AddScoped<IVendorActionHandler, HuntressCreateOrganizationAction>();
        services.AddModuleServices(typeof(HuntressModule).Assembly);
        return services;
    }

    private static void Configure(IServiceProvider services, HttpClient client)
    {
        var options = services.GetRequiredService<IOptions<HuntressOptions>>().Value;
        client.BaseAddress = options.BaseUrl;
        client.Timeout = TimeSpan.FromMinutes(2);
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        HuntressAuthentication.Apply(client.DefaultRequestHeaders, options);
    }

    private static void Pipeline(ResiliencePipelineBuilder<HttpResponseMessage> pipeline, IServiceProvider services, Func<HuntressOptions, int> perMinute)
    {
        var options = services.GetRequiredService<IOptions<HuntressOptions>>().Value;
        // Order matters: the retry is outermost so that every attempt, a retry included, takes a permit from the limiter and runs
        // under its own timeout (DEV-19).
        pipeline.AddRetry(new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 4,
            UseJitter = true,
            BackoffType = DelayBackoffType.Exponential,
            Delay = options.RetryDelay,
            ShouldRetryAfterHeader = true,
            ShouldHandle = args => ValueTask.FromResult(ShouldRetry(args.Context.GetRequestMessage()?.Method, args.Outcome.Result?.StatusCode, args.Outcome.Exception)),
        });
        pipeline.AddRateLimiter(Limiter(perMinute(options)));
        pipeline.AddTimeout(TimeSpan.FromSeconds(60));
    }

    /// <summary>At most <paramref name="perMinute"/> requests in any <see cref="Window"/>, the oldest waiting request first.</summary>
    internal static SlidingWindowRateLimiter Limiter(int perMinute) => new(new SlidingWindowRateLimiterOptions
    {
        PermitLimit = Math.Max(1, perMinute),
        Window = Window,
        SegmentsPerWindow = 7,
        QueueLimit = 100_000,
        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
        AutoReplenishment = true,
    });

    /// <summary>
    /// 429 means Huntress did not process the request, so it is safe to repeat for any method. Huntress has no idempotency key: a
    /// timeout, a dropped connection or a 5xx proves nothing about a write, so only reads repeat on those; an action's outcome is
    /// settled by reading Huntress again (DEV-19).
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
