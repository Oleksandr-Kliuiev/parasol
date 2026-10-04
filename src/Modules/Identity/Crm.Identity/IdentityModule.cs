using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Identity.Features;
using Crm.Identity.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Identity;

public static class IdentityModule
{
    public static readonly string[] SupportedLanguages = ["nb", "en", "ru"];

    public static IServiceCollection AddIdentityModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<IdentityDbContext>(configuration);
        services.AddModuleServices(typeof(IdentityModule).Assembly);
        services.AddScoped<IUserProvisioning, UserProvisioning>();
        services.AddScoped<IUserDirectory, UserDirectory>();
        services.AddScoped<IUserDirectorySync, UserDirectorySync>();
        services.AddScoped<ISessionDirectory, SessionDirectory>();
        services.AddScoped<IUserRoleDirectory, UserRoleDirectory>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, SessionRetention>();
        services.AddScoped<ITechnicianDirectory, TechnicianDirectory>();
        return services;
    }

    public static IEndpointRouteBuilder MapIdentityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/identity").WithTags("Identity");

        group.MapGet("/users", async (IdentityDbContext db, string? search, bool? includeInactive, CancellationToken ct) =>
            {
                var query = db.Users.AsNoTracking();
                if (includeInactive != true)
                {
                    query = query.Where(u => u.IsActive);
                }

                if (!string.IsNullOrWhiteSpace(search))
                {
                    var term = search.Trim();
                    query = query.Where(u => u.DisplayName.Contains(term) || (u.Email != null && u.Email.Contains(term)));
                }

                var users = await query
                    .OrderBy(u => u.DisplayName)
                    .Take(200)
                    .Select(u => new UserSummary(u.Id, u.DisplayName, u.Email, u.IsActive))
                    .ToListAsync(ct);
                return Results.Ok(users);
            })
            .RequirePermission(Permissions.UsersRead);

        group.MapGet("/technicians", async (IdentityDbContext db, bool? unmappedOnly, CancellationToken ct) =>
            {
                var query = db.TechnicianMappings.AsNoTracking();
                if (unmappedOnly == true)
                {
                    query = query.Where(m => m.UserId == null);
                }

                var rows = await query.OrderBy(m => m.UserId != null).ThenBy(m => m.Name).Take(500).ToListAsync(ct);
                var userIds = rows.Where(r => r.UserId != null).Select(r => r.UserId!.Value).Distinct().ToList();
                var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
                return Results.Ok(rows.Select(r => new TechnicianMappingItem(
                    r.Id, r.System, r.ExternalId, r.Name, r.Email, r.UserId, r.UserId is { } id ? users.GetValueOrDefault(id) : null, r.Method, r.LastSeenAt)).ToList());
            })
            .RequirePermission(Permissions.UsersRead);

        group.MapPut("/technicians/{id:guid}", async (Guid id, TechnicianMappingRequest request, IdentityDbContext db, CancellationToken ct) =>
            {
                if (await db.TechnicianMappings.SingleOrDefaultAsync(m => m.Id == id, ct) is not { } mapping)
                {
                    return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "IDN_TECHNICIAN_NOT_FOUND", extensions: new Dictionary<string, object?> { ["code"] = "IDN_TECHNICIAN_NOT_FOUND" });
                }

                if (request.UserId is { } userId && !await db.Users.AnyAsync(u => u.Id == userId, ct))
                {
                    return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "IDN_UNKNOWN_USER", extensions: new Dictionary<string, object?> { ["code"] = "IDN_UNKNOWN_USER" });
                }

                mapping.MapTo(request.UserId);
                await db.SaveChangesAsync(ct);
                return Results.NoContent();
            })
            .RequirePermission(Permissions.IntegrationsManage);

        group.MapPut("/me/preferences", async (PreferencesRequest request, ICurrentUser currentUser, IdentityDbContext db, CancellationToken ct) =>
            {
                if (request.Language is not null && !SupportedLanguages.Contains(request.Language))
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        ["language"] = [$"Supported languages: {string.Join(", ", SupportedLanguages)}."],
                    });
                }

                var user = await db.Users.SingleOrDefaultAsync(u => u.Id == currentUser.UserId, ct);
                if (user is null)
                {
                    return Results.NotFound();
                }

                user.SetPreferredLanguage(request.Language);
                await db.SaveChangesAsync(ct);
                return Results.NoContent();
            });

        return app;
    }
}

public sealed record PreferencesRequest(string? Language);

public sealed record TechnicianMappingRequest(Guid? UserId);

public sealed record TechnicianMappingItem(
    Guid Id, string System, string ExternalId, string? Name, string? Email, Guid? UserId, string? UserName, Crm.Identity.Domain.TechnicianMappingMethod Method, DateTimeOffset LastSeenAt);
