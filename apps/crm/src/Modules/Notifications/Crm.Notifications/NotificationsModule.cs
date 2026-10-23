using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Notifications.Contracts;
using Crm.Notifications.Features;
using Crm.Notifications.Persistence;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Notifications;

public static class NotificationsModule
{
    public static IServiceCollection AddNotificationsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<NotificationsDbContext>(configuration);
        services.AddOptions<NotificationsOptions>().Bind(configuration.GetSection(NotificationsOptions.SectionName));
        services.AddOptions<Features.TeamsNotificationOptions>().Bind(configuration.GetSection(Features.TeamsNotificationOptions.SectionName));
        services.AddModuleServices(typeof(NotificationsModule).Assembly);
        services.AddScoped<NotificationService>();
        services.AddScoped<INotificationsApi>(sp => sp.GetRequiredService<NotificationService>());
        services.AddScoped<NotificationScanJob>();
        services.AddScoped<NotificationDigestJob>();
        services.AddScoped<Crm.SharedKernel.Operations.IRestoreParticipant, Features.NotificationsRestoreParticipant>();
        services.AddScoped<ChannelNotices>();
        services.AddScoped<ChannelPostJob>();
        // A mail sender comes from an integration (Microsoft Graph). Without one the digest has nowhere to go and notices
        // stay in the CRM, marked as suppressed.
        return services;
    }

    /// <summary>
    /// Notifications belong to the signed-in user, so these endpoints authorize by ownership instead of a permission
    /// (like the language preference in Identity).
    /// </summary>
    public static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/notifications").WithTags("Notifications");

        group.MapGet("/", async (bool? unreadOnly, int? limit, string? cursor, NotificationService service, CancellationToken ct) =>
            Results.Ok(await service.ListAsync(unreadOnly ?? false, limit, cursor, ct)));

        group.MapPost("/{id:guid}/read", async (Guid id, NotificationService service, CancellationToken ct) =>
            (await service.MarkReadAsync(id, ct)).ToHttpResult(Results.NoContent));

        group.MapPost("/read-all", async (NotificationService service, CancellationToken ct) =>
            Results.Ok(new { read = await service.MarkAllReadAsync(ct) }));

        group.MapGet("/preferences", async (NotificationService service, CancellationToken ct) => Results.Ok(await service.GetPreferencesAsync(ct)));

        group.MapPut("/preferences", async (PreferencesRequest request, NotificationService service, CancellationToken ct) =>
            Results.Ok(await service.SavePreferencesAsync(request, ct))).Validate<PreferencesRequest>();

        return app;
    }
}
