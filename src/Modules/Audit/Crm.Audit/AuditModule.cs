using System.Text.Json;
using Crm.Audit.Persistence;
using Crm.Authorization;
using Crm.Infrastructure.DependencyInjection;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Audit;

public sealed record AuditEntryDto(
    long Id,
    DateTimeOffset At,
    Guid? UserId,
    string? UserName,
    string Action,
    string Module,
    string EntityType,
    Guid EntityId,
    JsonElement? Changes,
    string? CorrelationId);

public sealed record AuditPage(IReadOnlyList<AuditEntryDto> Items, long? NextCursor);

public static class AuditModule
{
    /// <summary>
    /// Permission needed to read the change history of one record, by module schema. Modules holding finance data
    /// must map to a finance permission (docs/06-security.md SEC-AZ-04).
    /// </summary>
    private static readonly Dictionary<string, string> EntityHistoryPermissions = new(StringComparer.Ordinal)
    {
        ["customers"] = Permissions.CustomersRead,
        ["identity"] = Permissions.UsersRead,
    };

    public static IServiceCollection AddAuditModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<AuditDbContext>(configuration);
        services.AddOptions<Features.AuditIntegrityOptions>().Bind(configuration.GetSection(Features.AuditIntegrityOptions.SectionName));
        services.AddScoped<Features.AuditIntegrityJob>();
        services.AddSingleton<Infrastructure.Persistence.IDatabasePermissionRules, AuditDatabasePermissions>();
        return services;
    }

    public static IEndpointRouteBuilder MapAuditEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/audit").WithTags("Audit");

        group.MapGet("/", async ([AsParameters] AuditQuery q, AuditDbContext db, CancellationToken ct) =>
            {
                var entries = db.AuditEntries.AsNoTracking();
                if (!string.IsNullOrWhiteSpace(q.Module))
                {
                    entries = entries.Where(e => e.Module == q.Module);
                }

                if (!string.IsNullOrWhiteSpace(q.EntityType))
                {
                    entries = entries.Where(e => e.EntityType == q.EntityType);
                }

                if (q.EntityId is { } entityId)
                {
                    entries = entries.Where(e => e.EntityId == entityId);
                }

                if (q.UserId is { } userId)
                {
                    entries = entries.Where(e => e.UserId == userId);
                }

                if (!string.IsNullOrWhiteSpace(q.Action))
                {
                    entries = entries.Where(e => e.Action == q.Action);
                }

                if (q.From is { } from)
                {
                    entries = entries.Where(e => e.At >= from);
                }

                if (q.To is { } to)
                {
                    entries = entries.Where(e => e.At < to);
                }

                return Results.Ok(await PageAsync(entries, q.Cursor, q.Limit, ct));
            })
            .RequirePermission(Permissions.AuditRead);

        group.MapGet("/entities/{module}/{entityType}/{entityId:guid}", async (
                string module, string entityType, Guid entityId, long? cursor, int? limit,
                AuditDbContext db, ICurrentUser user, CancellationToken ct) =>
            {
                if (!user.HasPermission(Permissions.AuditRead) &&
                    !(EntityHistoryPermissions.TryGetValue(module, out var permission) && user.HasPermission(permission)))
                {
                    return Results.Forbid();
                }

                var entries = db.AuditEntries.AsNoTracking()
                    .Where(e => e.Module == module && e.EntityType == entityType && e.EntityId == entityId);
                return Results.Ok(await PageAsync(entries, cursor, limit, ct));
            });

        return app;
    }

    private static async Task<AuditPage> PageAsync(IQueryable<Infrastructure.Persistence.AuditEntry> entries, long? cursor, int? limit, CancellationToken ct)
    {
        var take = KeysetCursor.ClampLimit(limit);
        if (cursor is { } c)
        {
            entries = entries.Where(e => e.Id < c);
        }

        var rows = await entries.OrderByDescending(e => e.Id).Take(take + 1).ToListAsync(ct);
        var items = rows.Take(take).Select(e => new AuditEntryDto(
            e.Id, e.At, e.UserId, e.UserName, e.Action, e.Module, e.EntityType, e.EntityId,
            e.Changes is null ? null : JsonDocument.Parse(e.Changes).RootElement.Clone(),
            e.CorrelationId)).ToList();
        return new AuditPage(items, rows.Count > take ? items[^1].Id : null);
    }
}

public sealed record AuditQuery(
    [FromQuery] string? Module,
    [FromQuery] string? EntityType,
    [FromQuery] Guid? EntityId,
    [FromQuery] Guid? UserId,
    [FromQuery] string? Action,
    [FromQuery] DateTimeOffset? From,
    [FromQuery] DateTimeOffset? To,
    [FromQuery] long? Cursor,
    [FromQuery] int? Limit);
