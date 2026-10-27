using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Identity.Features;
using Crm.Identity.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Identity;

public static class IdentityModule
{
    public static readonly string[] SupportedLanguages = ["nb", "nn", "en"];

    /// <summary>The My day layouts a person may choose (M38); what each one puts first is the interface's business.</summary>
    public static readonly string[] MyDayLayouts = ["work", "lead", "finance"];

    public static IServiceCollection AddIdentityModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<IdentityDbContext>(configuration);
        services.AddModuleServices(typeof(IdentityModule).Assembly);
        services.AddScoped<IUserProvisioning, UserProvisioning>();
        services.AddScoped<IUserDirectory, UserDirectory>();
        services.AddScoped<IUserDirectorySync, UserDirectorySync>();
        services.AddScoped<ISessionDirectory, SessionDirectory>();
        services.AddScoped<IUserRoleDirectory, UserRoleDirectory>();
        services.AddScoped<Crm.SharedKernel.Operations.IOperationalSignalSource, IdentityOperationalSignals>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, SessionRetention>();
        services.AddScoped<ITechnicianDirectory, TechnicianDirectory>();
        return services;
    }

    public static IEndpointRouteBuilder MapIdentityEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/identity").WithTags("Identity");

        group.MapGet("/users", async (IdentityDbContext db, string? search, bool? includeInactive, int? limit, string? cursor, CancellationToken ct) =>
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

                // By name, then id (DEV-12): a page per request and the count of all; a picker says when typing would narrow it.
                var total = await query.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after)
                {
                    query = query.Where(u => u.DisplayName.CompareTo(after.SortKey) > 0 || (u.DisplayName == after.SortKey && u.Id.CompareTo(after.Id) > 0));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await query
                    .OrderBy(u => u.DisplayName).ThenBy(u => u.Id)
                    .Take(take + 1)
                    .Select(u => new UserSummary(u.Id, u.DisplayName, u.Email, u.IsActive))
                    .ToListAsync(ct);
                var users = page.Take(take).ToList();
                return Results.Ok(new PagedResult<UserSummary>(
                    users, page.Count > take ? new KeysetCursor(users[^1].DisplayName, users[^1].Id).Encode() : null, total));
            })
            .RequirePermission(Permissions.UsersRead);

        group.MapGet("/technicians", async (IdentityDbContext db, bool? unmappedOnly, int? limit, string? cursor, CancellationToken ct) =>
            {
                var query = db.TechnicianMappings.AsNoTracking();
                if (unmappedOnly == true)
                {
                    query = query.Where(m => m.UserId == null && !m.Shared);
                }

                // Unmapped first (a shared technician is decided, not waiting), then by the name shown (the external id when
                // there is none), then id (DEV-12).
                var total = await query.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after && after.Then is { } label)
                {
                    var rank = after.SortKey == "0" ? 0 : 1;
                    query = query.Where(m => (m.UserId == null && !m.Shared ? 0 : 1) > rank ||
                        ((m.UserId == null && !m.Shared ? 0 : 1) == rank && ((m.Name ?? m.ExternalId).CompareTo(label) > 0 || ((m.Name ?? m.ExternalId) == label && m.Id.CompareTo(after.Id) > 0))));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await query.OrderBy(m => m.UserId == null && !m.Shared ? 0 : 1).ThenBy(m => m.Name ?? m.ExternalId).ThenBy(m => m.Id).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                var next = page.Count > take
                    ? new KeysetCursor(rows[^1].UserId == null && !rows[^1].Shared ? "0" : "1", rows[^1].Id, rows[^1].Name ?? rows[^1].ExternalId).Encode()
                    : null;
                var userIds = rows.Where(r => r.UserId != null).Select(r => r.UserId!.Value).Distinct().ToList();
                var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
                return Results.Ok(new PagedResult<TechnicianMappingItem>(rows.Select(r => new TechnicianMappingItem(
                    r.Id, r.System, r.ExternalId, r.Name, r.Email, r.UserId, r.UserId is { } id ? users.GetValueOrDefault(id) : null, r.Shared, r.Method, r.LastSeenAt)).ToList(), next, total));
            })
            .RequirePermission(Permissions.UsersRead);

        group.MapPut("/technicians/{id:guid}", async (Guid id, TechnicianMappingRequest request, IdentityDbContext db, CancellationToken ct) =>
            {
                if (await db.TechnicianMappings.SingleOrDefaultAsync(m => m.Id == id, ct) is not { } mapping)
                {
                    return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "IDN_TECHNICIAN_NOT_FOUND", extensions: new Dictionary<string, object?> { ["code"] = "IDN_TECHNICIAN_NOT_FOUND" });
                }

                if (request.Shared && request.UserId is not null)
                {
                    return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "IDN_SHARED_WITH_USER", extensions: new Dictionary<string, object?> { ["code"] = "IDN_SHARED_WITH_USER" });
                }

                if (request.UserId is { } userId && !await db.Users.AnyAsync(u => u.Id == userId, ct))
                {
                    return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "IDN_UNKNOWN_USER", extensions: new Dictionary<string, object?> { ["code"] = "IDN_UNKNOWN_USER" });
                }

                if (!request.Shared)
                {
                    mapping.MapTo(request.UserId);
                }
                else if (await db.TechnicianMappings.AnyAsync(m => m.System == mapping.System && m.Shared && m.Id != mapping.Id, ct))
                {
                    // One shared technician per system: a person ends the other one's sharing first, nothing is moved silently.
                    return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "IDN_SHARED_TECHNICIAN_TAKEN", extensions: new Dictionary<string, object?> { ["code"] = "IDN_SHARED_TECHNICIAN_TAKEN" });
                }
                else
                {
                    mapping.ShareWithEveryone();
                }

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

        // M38: the person's own choice of what My day puts first. A request of its own, because /me/preferences sets the
        // language to whatever it is sent, so saving the layout there would reset a chosen language.
        group.MapPut("/me/my-day-layout", async (MyDayLayoutRequest request, ICurrentUser currentUser, IdentityDbContext db, CancellationToken ct) =>
            {
                var user = await db.Users.SingleOrDefaultAsync(u => u.Id == currentUser.UserId, ct);
                if (user is null)
                {
                    return Results.NotFound();
                }

                user.SetMyDayLayout(request.Layout!);
                await db.SaveChangesAsync(ct);
                return Results.NoContent();
            })
            .Validate<MyDayLayoutRequest>();

        return app;
    }
}

public sealed record PreferencesRequest(string? Language);

/// <param name="Layout">One of <see cref="IdentityModule.MyDayLayouts"/>.</param>
public sealed record MyDayLayoutRequest(string? Layout);

internal sealed class MyDayLayoutRequestValidator : AbstractValidator<MyDayLayoutRequest>
{
    public MyDayLayoutRequestValidator() => RuleFor(x => x.Layout)
        .Must(layout => layout is not null && IdentityModule.MyDayLayouts.Contains(layout, StringComparer.Ordinal))
        .WithMessage($"Supported layouts: {string.Join(", ", IdentityModule.MyDayLayouts)}.");
}

/// <summary>A person to map the technician to, or no one; <c>Shared</c> makes it the technician everyone without their own writes as.</summary>
public sealed record TechnicianMappingRequest(Guid? UserId, bool Shared = false);

public sealed record TechnicianMappingItem(
    Guid Id, string System, string ExternalId, string? Name, string? Email, Guid? UserId, string? UserName, bool Shared,
    Crm.Identity.Domain.TechnicianMappingMethod Method, DateTimeOffset LastSeenAt);
