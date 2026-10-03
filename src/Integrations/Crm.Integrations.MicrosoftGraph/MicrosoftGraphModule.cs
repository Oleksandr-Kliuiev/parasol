using Azure.Core;
using Azure.Identity;
using Crm.Activities.Contracts;
using Crm.Customers.Contracts;
using Crm.Notifications.Contracts;
using Crm.SharedKernel.Domain;
using Crm.Sales.Contracts;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

public static class MicrosoftGraphModule
{
    public const string HttpClientName = "microsoft-graph";

    /// <summary>Calls made with the signed-in user's own token (calendar, mailbox).</summary>
    public const string DelegatedHttpClientName = "microsoft-graph-user";

    public static IServiceCollection AddMicrosoftGraphIntegration(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<GraphOptions>().Bind(configuration.GetSection(GraphOptions.SectionName));
        services.TryAddSingleton<TokenCredential>(sp => new DefaultAzureCredential(new DefaultAzureCredentialOptions
        {
            ManagedIdentityClientId = sp.GetRequiredService<IOptions<GraphOptions>>().Value.ManagedIdentityClientId,
        }));
        services.AddTransient<GraphAuthenticationHandler>();
        services.AddHttpClient<IGraphUserSource, GraphUserSource>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromMinutes(2);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .AddStandardResilienceHandler();
        services.AddOptions<GraphMailOptions>().Bind(configuration.GetSection(GraphMailOptions.SectionName));
        services.AddHttpClient<INotificationEmailSender, GraphMailSender>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .AddStandardResilienceHandler();
        services.AddOptions<SalesMailOptions>().Bind(configuration.GetSection(SalesMailOptions.SectionName));
        services.AddHttpClient<IQuoteMailSender, GraphQuoteMailSender>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(60);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
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
            .AddStandardResilienceHandler();
        services.AddHttpClient<IUserMailbox, GraphMailbox>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphDelegatedAuthenticationHandler>()
            .AddStandardResilienceHandler();

        // SharePoint runs on the application identity (Sites.Selected), Teams on a webhook URL that carries its own secret.
        services.AddHttpClient<GraphDocuments>((sp, client) =>
            {
                client.BaseAddress = sp.GetRequiredService<IOptions<GraphOptions>>().Value.BaseUrl;
                client.Timeout = TimeSpan.FromSeconds(30);
            })
            .AddHttpMessageHandler<GraphAuthenticationHandler>()
            .AddStandardResilienceHandler();
        services.AddScoped<IDocumentLibrary>(sp => sp.GetRequiredService<GraphDocuments>());
        services.AddScoped<IDomainEventHandler<Crm.Customers.Contracts.OrganizationCreated>, OrganizationFolderHandler>();
        services.AddScoped<IDomainEventHandler<Crm.Customers.Contracts.OrganizationUpdated>, OrganizationFolderHandler>();
        services.AddHttpClient<ITeamsChannelSender, TeamsChannelSender>(client => client.Timeout = TimeSpan.FromSeconds(15))
            .AddStandardResilienceHandler();

        services.AddScoped<EntraUserSyncJob>();
        return services;
    }
}
