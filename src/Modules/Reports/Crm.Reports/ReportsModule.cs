using Crm.Authorization;
using Crm.Infrastructure.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Reports;

/// <summary>Reporting owns no data: it reads the modules through their contracts, so it needs no schema of its own.</summary>
public static class ReportsModule
{
    public static IServiceCollection AddReportsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddScoped<DashboardService>();
        services.AddScoped<MarginService>();
        services.AddScoped<MartService>();
        services.AddOptions<ReportsOptions>().Bind(configuration.GetSection(ReportsOptions.SectionName));
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
            .RequireRateLimiting(RateLimitPolicies.Export);

        return app;
    }
}
