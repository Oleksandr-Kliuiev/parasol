using System.Globalization;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Crm.Reports;

/// <summary>Reporting owns no data: it reads the modules through their contracts, so it needs no schema of its own.</summary>
public static class ReportsModule
{
    public static IServiceCollection AddReportsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddScoped<DashboardService>();
        services.AddScoped<MarginService>();
        services.AddScoped<MartService>();
        services.AddScoped<BiService>();
        services.AddScoped<BiSnapshotService>();
        services.AddScoped<BiSnapshotJob>();
        services.AddOptions<ReportsOptions>().Bind(configuration.GetSection(ReportsOptions.SectionName));
        services.AddOptions<BiOptions>().Bind(configuration.GetSection(BiOptions.SectionName));
        // DEV-14: the BI read API takes Entra bearer tokens on its own scheme and policy; nothing else does.
        services.AddSingleton<IAuthorizationHandler, BiAuthorizationHandler>();
        services.AddAuthorizationBuilder().AddPolicy(BiAccess.Policy, policy => policy
            .AddAuthenticationSchemes(BiAccess.Scheme)
            .RequireAuthenticatedUser()
            .AddRequirements(new BiRequirement()));
        return services;
    }

    public static IEndpointRouteBuilder MapReportsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/reports/dashboard", async (int? months, DashboardService dashboard, CancellationToken ct) =>
                Results.Ok(await dashboard.GetAsync(months ?? 6, ct)))
            .WithTags("Reports")
            .RequirePermission(Permissions.ReportsRead);

        // FR-RPT-02: what each customer was billed against what they cost us; cost is finance data, hence the permission.
        app.MapGet("/api/v1/reports/margins", async (int year, int month, int? months, MarginService margins, CancellationToken ct) =>
                (await margins.GetAsync(year, month, months ?? 1, ct)).ToHttpResult(Results.Ok))
            .WithTags("Reports")
            .RequirePermission(Permissions.FinanceCostRead);

        // FR-RPT-03: read-only tables for Power BI's Web connector — same permissions, same contracts, no direct SQL.
        app.MapGet("/api/v1/reports/mart", () => Results.Ok(new { datasets = MartService.Datasets }))
            .WithTags("Reports")
            .RequirePermission(Permissions.ReportsMart);

        app.MapGet("/api/v1/reports/mart/{dataset}", async (
                string dataset, DateOnly? from, DateOnly? to, string? format, MartService mart, TimeProvider time, CancellationToken ct) =>
            {
                var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
                var result = await mart.GetAsync(dataset, from ?? today.AddMonths(-12), to ?? today, ct);
                return result.ToHttpResult(table => string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase)
                    ? Results.Text(MartService.ToCsv(table), "text/csv; charset=utf-8")
                    : Results.Ok(table));
            })
            .WithTags("Reports")
            .RequirePermission(Permissions.ReportsMart)
            .ExportsData()
            .RequireRateLimiting(RateLimitPolicies.Export);

        MapSnapshotEndpoints(app);
        if (app.ServiceProvider.GetRequiredService<IOptions<BiOptions>>().Value.Enabled)
        {
            MapBiEndpoints(app);
        }

        return app;
    }

    /// <summary>Finance takes (or revises) the snapshot of a closed month and sees what exists (DEV-14).</summary>
    private static void MapSnapshotEndpoints(IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/reports/snapshots/{month}", async (string month, BiSnapshotService snapshots, CancellationToken ct) =>
            {
                if (BiSnapshotService.MonthOf(month) == default)
                {
                    return Problem(StatusCodes.Status400BadRequest, "RPT_SNAPSHOT_MONTH", "Give the month as yyyy-MM.");
                }

                var list = new List<object>();
                foreach (var dataset in BiService.Datasets.Where(d => d.Snapshot))
                {
                    list.Add(new { dataset = dataset.Name, revisions = await snapshots.RevisionsAsync(dataset.Name, month, ct) });
                }

                return Results.Ok(new { month, datasets = list });
            })
            .WithTags("Reports")
            .RequirePermission(Permissions.FinanceCostRead);

        app.MapPost("/api/v1/reports/snapshots/{month}", async (
                string month, SnapshotRequest? request, BiSnapshotService snapshots, ICurrentUser user, CancellationToken ct) =>
                (await snapshots.CaptureAsync(month, user.DisplayName ?? "unknown", request?.Reason?.Trim(), request?.Revise ?? false, ct))
                    .ToHttpResult(taken => Results.Ok(new { month, taken })))
            .WithTags("Reports")
            .RequirePermission(Permissions.FinanceCostRead);
    }

    /// <summary>
    /// The BI read API (DEV-14, ADR-022): bearer-token only, one policy, a rate limit per client application. Datasets are paged
    /// by key; a refresh reads every page, and the last page's watermark is the <c>asOf</c> it began at.
    /// </summary>
    private static void MapBiEndpoints(IEndpointRouteBuilder app)
    {
        var bi = app.MapGroup("/api/v1/bi/v1").WithTags("BI").RequireAuthorization(BiAccess.Policy).RequireRateLimiting(RateLimitPolicies.BiRefresh);

        bi.MapGet("/", (ClaimsPrincipal user) => Results.Ok(new
        {
            schemaVersion = BiService.SchemaVersion,
            datasets = BiService.Datasets.Where(d => BiAccess.MayRead(user, d)).Select(d => new
            {
                name = d.Name,
                definition = d.Definition,
                snapshots = d.Snapshot,
                keyColumns = d.Columns.Take(d.KeyColumns).Select(c => c.Name),
                columns = d.Columns,
            }),
            glossary = BiService.Glossary,
        }));

        bi.MapGet("/datasets/{dataset}", async (
            string dataset, DateOnly? from, DateOnly? to, string? cursor, int? pageSize, ClaimsPrincipal user, BiService service, TimeProvider time, CancellationToken ct) =>
        {
            if (BiService.Find(dataset) is not { } definition)
            {
                return Problem(StatusCodes.Status404NotFound, "RPT_MART_UNKNOWN", $"There is no dataset '{dataset}'.");
            }

            if (!BiAccess.MayRead(user, definition))
            {
                return Problem(StatusCodes.Status403Forbidden, "BI_DATASET_FORBIDDEN", "This identity may not read this dataset.");
            }

            var continuation = BiCursor.Decode(cursor);
            if (!string.IsNullOrEmpty(cursor) && continuation is null)
            {
                return Problem(StatusCodes.Status400BadRequest, "BI_CURSOR", "The cursor is not one this API issued.");
            }

            var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
            var asOf = continuation?.AsOf ?? service.Now;
            var table = await service.BuildAsync(definition, continuation?.From ?? from ?? today.AddMonths(-12), continuation?.To ?? to ?? today, asOf, ct);
            return table.ToHttpResult(t => Results.Ok(service.PageOf(t, continuation?.LastKey, pageSize ?? 0, asOf)));
        });

        bi.MapGet("/snapshots/{dataset}", async (
            string dataset, string month, int? revision, string? cursor, int? pageSize, ClaimsPrincipal user, BiSnapshotService snapshots, IOptions<ReportsOptions> options, CancellationToken ct) =>
        {
            if (BiService.Find(dataset) is not { Snapshot: true } definition)
            {
                return Problem(StatusCodes.Status404NotFound, "RPT_SNAPSHOT_NOT_FOUND", $"There is no snapshot dataset '{dataset}'.");
            }

            if (!BiAccess.MayRead(user, definition))
            {
                return Problem(StatusCodes.Status403Forbidden, "BI_DATASET_FORBIDDEN", "This identity may not read this dataset.");
            }

            var offset = 0;
            if (!string.IsNullOrEmpty(cursor) && (!cursor.StartsWith('o') || !int.TryParse(cursor[1..], NumberStyles.None, CultureInfo.InvariantCulture, out offset)))
            {
                return Problem(StatusCodes.Status400BadRequest, "BI_CURSOR", "The cursor is not one this API issued.");
            }

            return (await snapshots.ReadAsync(dataset, month, revision, ct)).ToHttpResult(document =>
            {
                var size = Math.Clamp(pageSize is > 0 ? pageSize.Value : options.Value.MartPageSize, 1, 5000);
                var rows = document.Rows.Skip(offset).Take(size).Select(r => (IReadOnlyList<object?>)r.Cast<object?>().ToList()).ToList();
                var more = offset + rows.Count < document.Rows.Count;
                return Results.Ok(new BiPage(
                    document.SchemaVersion, document.Dataset, document.AsOf, document.From, document.To, document.Columns, rows,
                    more ? $"o{offset + rows.Count}" : null, more ? null : document.AsOf, document.Provenance, document.Revision, document.Sha256));
            });
        });
    }

    private static IResult Problem(int status, string code, string detail) =>
        Results.Problem(statusCode: status, title: code, detail: detail, extensions: new Dictionary<string, object?> { ["code"] = code });
}

public sealed record SnapshotRequest(string? Reason, bool Revise);
