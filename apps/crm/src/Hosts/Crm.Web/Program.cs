using Crm.Audit;
using Crm.Catalog;
using Crm.Activities;
using Crm.Contracts;
using Crm.Billing;
using Crm.Notifications;
using Crm.Reports;
using Crm.Licensing;
using Crm.Privacy;
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
using Crm.Integrations.Core.Actions;
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

if (args.Contains("--health-probe", StringComparer.Ordinal))
{
    Environment.Exit(await VpsHostConfiguration.HealthProbeAsync());
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.AddVpsConfiguration(args);

builder.AddServiceDefaults();
// DEV-06: ready means the database answers and has this build's schema; external systems never decide readiness.
builder.Services.AddDatabaseReadiness();

builder.Services.AddHttpContextAccessor();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<PersistenceExceptionHandler>();
// The API description is a map of every route: served only where Openapi:Enabled says so (development by default), and then
// only to a signed-in holder of integrations.manage.
var openApiEnabled = builder.Configuration.GetValue("OpenApi:Enabled", builder.Environment.IsDevelopment());
if (openApiEnabled)
{
    builder.Services.AddOpenApi();
}

builder.Services.AddHsts(options =>
{
    options.MaxAge = TimeSpan.FromDays(365);
    options.IncludeSubDomains = true;
    options.Preload = false;
});
builder.Services.AddSingleton<IConfigureOptions<JsonOptions>, ConfigureJsonOptions>();
builder.Services.AddScoped<ICurrentUser, HttpCurrentUser>();
builder.Services.AddScoped<IRequestContext, HttpRequestContext>();
// UX 2026, В6: the customer list's facts and attention view, composed from the modules' contracts.
builder.Services.AddScoped<Crm.Web.CustomerFacts.CustomerFactsService>();

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
    .AddPrivacyModule(builder.Configuration)
    .AddBrregIntegration(builder.Configuration)
    .AddIntegrationsCore(builder.Configuration)
    .AddMicrosoftGraphIntegration(builder.Configuration)
    .AddPowerOfficeIntegration(builder.Configuration)
    .AddAteraIntegration(builder.Configuration)
    .AddPartnerCenterIntegration(builder.Configuration);

builder.Services.AddMemoryCache();
builder.AddCrmAuthentication();
builder.AddBiAuthentication();

// Delegated Graph (calendar, mailbox) only exists behind a real Entra session; the development sign-in has no token.
if (builder.Configuration.GetValue<string>("Auth:Mode") != "Development")
{
    builder.Services.AddScoped<IDelegatedTokenSource, EntraDelegatedTokenSource>();
}

builder.Services.AddCrmAuthorization();
// DEV-10: sessions and roles come from the server on every request (bounded per replica); a privileged action without a
// recent confirmation of the roles answers with a coded 403.
builder.Services.AddSingleton<SessionStateCache>();
builder.Services.AddScoped<IReportAccessAudit, ReportAccessAudit>();
builder.Services.AddSingleton<Microsoft.AspNetCore.Authorization.IAuthorizationMiddlewareResultHandler, CrmAuthorizationResultHandler>();
builder.AddDataProtection();
builder.Services.AddSingleton<Crm.Integrations.Core.Readiness.IConnectionCatalog, Crm.Web.ConnectionCatalog>();
Crm.Integrations.Core.Readiness.ConnectionStatusEndpoints.AddConnectionStatus(builder.Services);

var hangfireEnabled = builder.Configuration.GetValue("Hangfire:DashboardEnabled", true);
if (hangfireEnabled)
{
    // The dashboard's POSTs (trigger, requeue, delete) check an anti-forgery token only when the service exists; without it
    // Hangfire compares two empty values and accepts any form post. The token cookie is host-bound and never sent cross-site.
    builder.Services.AddAntiforgery(options =>
    {
        // A __Host- name needs Secure, which a local http dashboard cannot have; everywhere else the request is https.
        options.Cookie.Name = builder.Environment.IsDevelopment() ? "crm-antiforgery" : "__Host-crm-antiforgery";
        options.Cookie.Path = "/";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.HeaderName = "X-CSRF-TOKEN";
    });
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
    // The sign-in and sign-out paths (ASVS 2.4 / 6.3): each attempt costs a challenge and, on the callback, provisioning and a
    // session row, so they have a small budget per client address; the rest of /bff (who am I, sign out) follows the API's.
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
    {
        var path = context.Request.Path;
        if (path.StartsWithSegments("/api") || path.StartsWithSegments("/bff") && !IsSignInPath(path))
        {
            return RateLimitPartition.GetFixedWindowLimiter(Partition(context), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = builder.Configuration.GetValue("RateLimits:ApiPerMinute", 300),
                Window = TimeSpan.FromMinutes(1),
            });
        }

        return IsSignInPath(path)
            ? RateLimitPartition.GetFixedWindowLimiter("sign-in:" + (context.Connection.RemoteIpAddress?.ToString() ?? "unknown"), _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = builder.Configuration.GetValue("RateLimits:SignInPerMinute", 30),
                Window = TimeSpan.FromMinutes(1),
            })
            : RateLimitPartition.GetNoLimiter("static");
    });

    // DEV-14: a refresh reads every page of every dataset, so the BI API has a budget of its own, per client application.
    options.AddPolicy(RateLimitPolicies.BiRefresh, context => RateLimitPartition.GetFixedWindowLimiter(
        context.User.FindFirst("azp")?.Value ?? context.User.FindFirst("appid")?.Value ?? context.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("Bi:RequestsPerMinute", 120),
            Window = TimeSpan.FromMinutes(1),
        }));

    options.AddPolicy(RateLimitPolicies.Export, context => RateLimitPartition.GetFixedWindowLimiter(Partition(context), _ => new FixedWindowRateLimiterOptions
    {
        PermitLimit = builder.Configuration.GetValue("RateLimits:ExportsPerHour", 10),
        Window = TimeSpan.FromHours(1),
    }));

    options.AddPolicy(RateLimitPolicies.Migration, context => RateLimitPartition.GetFixedWindowLimiter(Partition(context), _ => new FixedWindowRateLimiterOptions
    {
        PermitLimit = builder.Configuration.GetValue("RateLimits:MigrationPerHour", 60),
        Window = TimeSpan.FromHours(1),
    }));

    options.OnRejected = async (context, token) =>
    {
        SecurityLog.For(context.HttpContext).RateLimited(context.HttpContext);
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
    HostSecurity.ConfigureForwardedHeaders(options, builder.Configuration, builder.Environment));

if (HostSecurity.AllowedHostsProblem(builder.Configuration["AllowedHosts"], builder.Environment) is { } hostsProblem)
{
    throw new InvalidOperationException(hostsProblem);
}

static bool IsSignInPath(PathString path) =>
    path.StartsWithSegments("/bff/login") || path.StartsWithSegments("/bff/dev-login") || path.StartsWithSegments("/bff/signout-entra") ||
    path.StartsWithSegments("/signin-oidc") || path.StartsWithSegments("/signout-oidc") || path.StartsWithSegments("/signout-callback-oidc");

var app = builder.Build();

// DEV-09: an environment that opens record scope says so on every start (ADR-018, runbook 11).
if (app.Services.GetRequiredService<IOptions<Crm.Infrastructure.Security.RecordScopeOptions>>().Value.RecordScope == RecordScopeMode.Open)
{
    app.Logger.LogWarning(
        "Record scope is Open: every holder of sales.read sees every quote, every holder of projects.read every project (DEV-09, runbook 11)");
}

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
app.UseMiddleware<PrivacyReplayMiddleware>();
app.UseDefaultFiles();
app.UseStaticFiles();
// DEV-13: read-only maintenance answers before authentication, so a refused change never reaches a handler; sign-in passes and
// provisioning admits only the operators (AuthenticationSetup.ProvisionUserAsync).
app.UseMiddleware<MaintenanceMiddleware>();
app.UseAuthentication();
app.UseMiddleware<ActiveUserMiddleware>();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<CsrfHeaderMiddleware>();

app.MapDefaultEndpoints();
if (openApiEnabled)
{
    app.MapOpenApi("/openapi/{documentName}.json").RequirePermission(Permissions.IntegrationsManage);
}

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
app.MapPilotReadinessEndpoints();
app.MapNotificationEndpoints();
app.MapReportsEndpoints();
app.MapPrivacyEndpoints();
app.MapBrregEndpoints();
app.MapSearchEndpoints();
Crm.Web.CustomerFacts.CustomerFactsEndpoints.MapCustomerFactsEndpoints(app);
app.MapIntegrationRunEndpoints();
app.MapIntegrationMappingEndpoints();
app.MapVendorActionEndpoints();
Crm.Integrations.Core.Readiness.ConnectionStatusEndpoints.MapConnectionStatus(app);
app.MapJobEndpoints();
app.MapOutboxEndpoints();
app.MapMonitoringEndpoints();
app.MapRecordScopeEndpoints();
app.MapOperationsEndpoints();
app.MapHealthDetails();

if (hangfireEnabled)
{
    var maintenance = app.Services.GetRequiredService<Crm.SharedKernel.Operations.IMaintenanceGate>();
    app.MapHangfireDashboard("/admin/jobs", new DashboardOptions
        {
            Authorization = [],
            AsyncAuthorization = [],
            DashboardTitle = "Vardahei CRM jobs",
            AppPath = "/admin",
            // DEV-13: no trigger, requeue or delete buttons while the CRM is read-only (the middleware refuses the POSTs anyway).
            IsReadOnlyFunc = _ => maintenance.Last.IsReadOnly,
        })
        .RequirePermission(Permissions.IntegrationsManage);
}

// SPA: unknown non-API routes serve index.html; API routes return 404 problem responses.
app.MapFallback("/api/{**path}", () => Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "NOT_FOUND")).AllowAnonymous();
app.MapFallbackToFile("index.html").AllowAnonymous();

await app.RunAsync();

public partial class Program;
