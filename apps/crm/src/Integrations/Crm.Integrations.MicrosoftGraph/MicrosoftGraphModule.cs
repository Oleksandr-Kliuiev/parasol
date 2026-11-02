using Azure.Core;
using Crm.Activities.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Notifications.Contracts;
using Crm.SharedKernel.Domain;
using Crm.Sales.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Http.Resilience;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

public static class MicrosoftGraphModule
{
    public const string HttpClientName = "microsoft-graph";

    /// <summary>Calls made with the signed-in user's own token (calendar, mailbox).</summary>
    public const string DelegatedHttpClientName = "microsoft-graph-user";

    // A redirect would carry the request, and with it a token or a card, to wherever the answer points (F-G5-12).
    private static HttpMessageHandler NoRedirects() => new SocketsHttpHandler { AllowAutoRedirect = false };

    public static IServiceCollection AddMicrosoftGraphIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<GraphOptions>().Bind(configuration.GetSection(GraphOptions.SectionName))
            .Validate(options => options.IsValid(out _), "Integrations:MicrosoftGraph has an address that is not https or a Teams webhook outside Teams:AllowedHostSuffixes.")
            .ValidateOnStart();
        services.TryAddSingleton<TokenCredential>(sp => FileGraphCredential.Create(
            sp.GetRequiredService<IOptions<GraphOptions>>().Value));
        services.AddTransient<GraphAuthenticationHandler>();
        services.AddHttpClient<IGraphUserSource, GraphUserSource>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();
        services.AddHttpClient<IGraphRoleAssignmentSource, GraphRoleAssignmentSource>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(1);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();
        services.AddOptions<GraphMailOptions>().Bind(configuration.GetSection(GraphMailOptions.SectionName));
        services.AddHttpClient<INotificationEmailSender, GraphMailSender>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();
        services.AddOptions<SalesMailOptions>().Bind(configuration.GetSection(SalesMailOptions.SectionName));
        services.AddHttpClient<IQuoteMailSender, GraphQuoteMailSender>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(60);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();

        // Delegated features: the web host plugs in the user's token; without it they report themselves unavailable.
        services.TryAddScoped<IDelegatedTokenSource, NoDelegatedToken>();
        services.AddTransient<GraphDelegatedAuthenticationHandler>();
        services.AddHttpClient<IUserCalendar, GraphCalendar>(DelegatedHttpClientName, (sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphDelegatedAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();
        services.AddHttpClient<IUserMailbox, GraphMailbox>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphDelegatedAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();

        // SharePoint (M47): the card reads a customer's folder with the person's own token (Files.Read.All); crm-worker lists the root
        // folder for the mapping screen, creates a folder a person asked for and renames one the CRM made, on the application identity
        // (Sites.Selected). A POST is never repeated automatically: a create that timed out may have been made.
        services.AddSingleton<SharePointDrive>();
        services.AddTransient<GraphFilesAuthenticationHandler>();
        services.AddHttpClient<GraphDocumentLibrary>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphFilesAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler();
        services.AddScoped<IDocumentLibrary>(sp => sp.GetRequiredService<GraphDocumentLibrary>());
        services.AddHttpClient<SharePointClient>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler(options => options.Retry.DisableForUnsafeHttpMethods());
        services.AddScoped<IIntegrationAdapter, SharePointAdapter>();
        services.AddScoped<IVendorActionGate, SharePointActionGate>();
        services.AddScoped<IVendorActionHandler, SharePointFolderCreation>();
        services.AddScoped<IOutboundHandler, SharePointFolderRename>();
        services.AddScoped<SharePointFolderSyncJob>();
        services.AddScoped<IDomainEventHandler<Crm.Customers.Contracts.OrganizationUpdated>, OrganizationFolderHandler>();
        // Teams runs on a webhook URL that carries its own secret.
        // One attempt of the channel queue is one POST: a webhook has no idempotency key, and an automatic retry of a POST
        // that timed out after Teams took it would post the card twice (DEV-07). The queue retries later instead.
        services.AddHttpClient<ITeamsChannelSender, TeamsChannelSender>(client => client.Timeout = TimeSpan.FromSeconds(15))
            .ConfigurePrimaryHttpMessageHandler(NoRedirects)
            .AddStandardResilienceHandler(options => options.Retry.DisableForUnsafeHttpMethods());

        services.AddScoped<EntraUserSyncJob>();
        services.AddScoped<EntraRoleSyncJob>();
        return services;
    }
}
