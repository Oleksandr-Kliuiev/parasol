using Crm.Audit;
using Crm.Catalog;
using Crm.Activities;
using Crm.Contracts;
using Crm.Billing;
using Crm.Notifications;
using Crm.Reports;
using Crm.Licensing;
using Crm.Projects;
using Crm.Sales;
using Crm.Service;
using Crm.TimeTracking;
using Crm.CustomFields;
using Crm.Customers;
using Crm.Identity;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Brreg;
using Crm.Integrations.Core;
using Crm.Integrations.MicrosoftGraph;
using Crm.Integrations.PartnerCenter;
using Crm.Integrations.PowerOffice;
using Crm.Integrations.Atera;
using Crm.SharedKernel.Application;
using Crm.Authorization;
using Crm.Web.Auth;
using Crm.Web.Bff;
using Crm.Web.Http;
using Crm.Web.Search;
using Hangfire;
using Hangfire.Dashboard;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Extensions.Options;
using System.Threading.RateLimiting;
using Crm.Infrastructure.Http;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
// DEV-06: ready means the database answers and has this build's schema; external systems never decide readiness.
builder.Services.AddDatabaseReadiness();

builder.Services.AddHttpContextAccessor();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<PersistenceExceptionHandler>();
builder.Services.AddOpenApi();
builder.Services.AddSingleton<IConfigureOptions<JsonOptions>, ConfigureJsonOptions>();
builder.Services.AddScoped<ICurrentUser, HttpCurrentUser>();
builder.Services.AddScoped<IRequestContext, HttpRequestContext>();

// Modules. Audit is registered first: it owns the audit table that other modules write to.
builder.Services
    .AddAuditModule(builder.Configuration)
    .AddIdentityModule(builder.Configuration)
    .AddCustomersModule(builder.Configuration)
    .AddCustomFieldsModule(builder.Configuration)
    .AddCatalogModule(builder.Configuration)
    .AddContractsModule(builder.Configuration)
    .AddServiceModule(builder.Configuration)
    .AddTimeTrackingModule(builder.Configuration)
    .AddSalesModule(builder.Configuration)
    .AddProjectsModule(builder.Configuration)
    .AddActivitiesModule(builder.Configuration)
    .AddLicensingModule(builder.Configuration)
    .AddBillingModule(builder.Configuration)
    .AddNotificationsModule(builder.Configuration)
    .AddReportsModule(builder.Configuration)
    .AddBrregIntegration(builder.Configuration)
    .AddIntegrationsCore(builder.Configuration)
    .AddMicrosoftGraphIntegration(builder.Configuration)
    .AddPowerOfficeIntegration(builder.Configuration)
    .AddAteraIntegration(builder.Configuration)
    .AddPartnerCenterIntegration(builder.Configuration);

builder.Services.AddMemoryCache();
builder.AddCrmAuthentication();

// Delegated Graph (calendar, mailbox) only exists behind a real Entra session; the development sign-in has no token.
if (builder.Configuration.GetValue<string>("Auth:Mode") != "Development")
{
    builder.Services.AddScoped<IDelegatedTokenSource, EntraDelegatedTokenSource>();
}

builder.Services.AddCrmAuthorization();
builder.AddDataProtection();

var hangfireEnabled = builder.Configuration.GetValue("Hangfire:DashboardEnabled", true);
if (hangfireEnabled)
{
    builder.Services.AddHangfire(config => config
        .UseSimpleAssemblyNameTypeSerializer()
        .UseRecommendedSerializerSettings()
        .UseSqlServerStorage(builder.Configuration.GetConnectionString(ModuleRegistration.ConnectionStringName),
            new Hangfire.SqlServer.SqlServerStorageOptions
            {
                SchemaName = "hangfire",
                PrepareSchemaIfNecessary = builder.Configuration.GetValue("Hangfire:PrepareSchema", false),
            }));
}

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    static string Partition(HttpContext context) =>
        context.User.FindFirst(CrmClaimTypes.UserId)?.Value ?? context.Connection.RemoteIpAddress?.ToString() ?? "anonymous";

    // All API calls: 300 per user per minute (docs/06-security.md §4).
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        context.Request.Path.StartsWithSegments("/api")
            ? RateLimitPartition.GetFixedWindowLimiter(Partition(context), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = builder.Configuration.GetValue("RateLimits:ApiPerMinute", 300),
                Window = TimeSpan.FromMinutes(1),
            })
            : RateLimitPartition.GetNoLimiter("static"));

    options.AddPolicy(RateLimitPolicies.Export, context => RateLimitPartition.GetFixedWindowLimiter(Partition(context), _ => new FixedWindowRateLimiterOptions
    {
        PermitLimit = builder.Configuration.GetValue("RateLimits:ExportsPerHour", 10),
        Window = TimeSpan.FromHours(1),
    }));

    options.OnRejected = async (context, token) =>
    {
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter = ((int)retryAfter.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        await context.HttpContext.Response.WriteAsJsonAsync(new
        {
            title = "RATE_LIMITED",
            status = 429,
            code = "RATE_LIMITED",
            detail = "Too many requests. Wait a moment and try again.",
        }, token);
    };
});

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
    // Azure Container Apps terminates TLS at its ingress; the proxy network is not known in advance.
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});

var app = builder.Build();

if (args.Contains(DatabaseMigrator.MigrateOnlyArgument))
{
    await DatabaseMigrator.MigrateAsync(app.Services);
    return;
}

if (app.Configuration.GetValue("Database:MigrateOnStartup", false))
{
    await DatabaseMigrator.MigrateAsync(app.Services);
}

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.UseMiddleware<SecurityHeadersMiddleware>();
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseAuthentication();
app.UseMiddleware<ActiveUserMiddleware>();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<CsrfHeaderMiddleware>();

app.MapDefaultEndpoints();
app.MapOpenApi("/openapi/{documentName}.json");
app.MapBffEndpoints();
app.MapIdentityEndpoints();
app.MapAuditEndpoints();
app.MapCustomersEndpoints();
app.MapCustomFieldsEndpoints();
app.MapCatalogEndpoints();
app.MapContractsEndpoints();
app.MapServiceEndpoints();
app.MapTimeTrackingEndpoints();
app.MapSalesEndpoints();
app.MapProjectsEndpoints();
app.MapActivitiesEndpoints();
app.MapLicensingEndpoints();
app.MapBillingEndpoints();
app.MapNotificationEndpoints();
app.MapReportsEndpoints();
app.MapBrregEndpoints();
app.MapSearchEndpoints();
app.MapIntegrationRunEndpoints();
app.MapIntegrationMappingEndpoints();
app.MapJobEndpoints();
app.MapOutboxEndpoints();
app.MapHealthDetails();

if (hangfireEnabled)
{
    app.MapHangfireDashboard("/admin/jobs", new DashboardOptions
        {
            Authorization = [],
            AsyncAuthorization = [],
            DashboardTitle = "Vardahei CRM jobs",
            AppPath = "/admin",
        })
        .RequirePermission(Permissions.IntegrationsManage);
}

// SPA: unknown non-API routes serve index.html; API routes return 404 problem responses.
app.MapFallback("/api/{**path}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "NOT_FOUND")).AllowAnonymous();
app.MapFallbackToFile("index.html").AllowAnonymous();

await app.RunAsync();

public partial class Program;
