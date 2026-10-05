using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Web.Http;

internal sealed class HttpCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    private ClaimsPrincipal? Principal => accessor.HttpContext?.User;

    public Guid? UserId => Guid.TryParse(Principal?.FindFirstValue(CrmClaimTypes.UserId), out var id) ? id : null;

    public string DisplayName => Principal?.FindFirstValue("name") ?? Principal?.Identity?.Name ?? "anonymous";

    public bool IsAuthenticated => Principal?.Identity?.IsAuthenticated == true;

    public bool HasPermission(string permission) => Principal?.GetPermissions().Contains(permission) == true;
}

internal sealed class HttpRequestContext(IHttpContextAccessor accessor) : IRequestContext
{
    public string? IpAddress => accessor.HttpContext?.Connection.RemoteIpAddress?.ToString();

    public string? CorrelationId => System.Diagnostics.Activity.Current?.TraceId.ToString() ?? accessor.HttpContext?.TraceIdentifier;
}

/// <summary>Enums as strings and server-side removal of <see cref="SensitiveDataAttribute"/> properties.</summary>
internal sealed class ConfigureJsonOptions(IHttpContextAccessor accessor) : IConfigureOptions<JsonOptions>
{
    public void Configure(JsonOptions options)
    {
        options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
        options.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.Never;
        var resolver = options.SerializerOptions.TypeInfoResolver ?? new DefaultJsonTypeInfoResolver();
        options.SerializerOptions.TypeInfoResolver = resolver.WithAddedModifier(
            SensitiveDataJsonModifier.Create(permission => accessor.HttpContext?.User.GetPermissions().Contains(permission) == true));
    }
}

/// <summary>
/// CSRF defence for cookie-authenticated calls (docs/03-architecture.md §6): state-changing requests to /api and /bff
/// must carry <c>X-CSRF: 1</c>, which a cross-site form or image cannot send without a CORS preflight.
/// </summary>
internal sealed class CsrfHeaderMiddleware(RequestDelegate next)
{
    public const string HeaderName = "X-CSRF";

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        var isProtected = path.StartsWithSegments("/api") || path.StartsWithSegments("/bff");
        if (isProtected && !HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method) &&
            !HttpMethods.IsOptions(context.Request.Method) && context.Request.Headers[HeaderName] != "1")
        {
            SecurityLog.For(context).CsrfRefused(context);
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new
            {
                title = "CSRF_HEADER_REQUIRED",
                status = 403,
                detail = $"State-changing requests must include the '{HeaderName}: 1' header.",
                code = "CSRF_HEADER_REQUIRED",
            });
            return;
        }

        await next(context);
    }
}

internal sealed class SecurityHeadersMiddleware(RequestDelegate next)
{
    // Fluent UI (Griffel) injects runtime styles, hence 'unsafe-inline' for styles only.
    private const string ContentSecurityPolicy =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com; base-uri 'self'; form-action 'self' https://login.microsoftonline.com";

    // Responses that are data, not pages: nothing in them is framed, scripted or loaded.
    private const string DataContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    private const string NoFramingPolicy = "frame-ancestors 'none'";

    public Task InvokeAsync(HttpContext context)
    {
        // Read before the pipeline runs: a branch (the job dashboard) rewrites Path and PathBase while it handles the request.
        var path = context.Request.Path;
        context.Response.OnStarting(() =>
        {
            var headers = context.Response.Headers;
            headers.XContentTypeOptions = "nosniff";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
            headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
            if (path.StartsWithSegments("/api") || path.StartsWithSegments("/openapi"))
            {
                headers.CacheControl = "no-store";
                headers.ContentSecurityPolicy = DataContentSecurityPolicy;
                headers.XFrameOptions = "DENY";
            }
            else if (path.StartsWithSegments("/bff") || path.StartsWithSegments("/admin/jobs") || path.StartsWithSegments("/health/details"))
            {
                // Signed-in answers (who I am, the job dashboard) are never kept by a browser or a proxy and never framed.
                // The dashboard's own pages bring inline script, so only framing is restricted there.
                headers.CacheControl = "no-store";
                headers.ContentSecurityPolicy = NoFramingPolicy;
                headers.XFrameOptions = "DENY";
            }
            else
            {
                headers.ContentSecurityPolicy = ContentSecurityPolicy;
            }

            return Task.CompletedTask;
        });
        return next(context);
    }
}

/// <summary>Maps persistence exceptions that escape handlers to problem responses.</summary>
internal sealed class PersistenceExceptionHandler(IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        // DEV-13: a write the request barrier let through (a hidden write in a read) is refused by the database interceptor;
        // the caller gets the same coded answer as any change during maintenance.
        if (exception is Crm.SharedKernel.Operations.MaintenanceReadOnlyException readOnly)
        {
            await Crm.Infrastructure.Http.MaintenanceHttp.WriteReadOnlyAsync(httpContext, readOnly.State);
            return true;
        }

        (int status, string code, string detail)? mapped = exception switch
        {
            DbUpdateConcurrencyException => (StatusCodes.Status412PreconditionFailed, "CONCURRENCY_CONFLICT",
                "The record was changed by someone else. Reload it and apply your changes again."),
            DbUpdateException { InnerException: SqlException { Number: 2601 or 2627 } } => (StatusCodes.Status409Conflict, "DUPLICATE",
                "A record with the same unique value already exists."),
            // Safety net (F-G1-06): a value longer than its column (8152/2628) or a number past its precision (8115) that no
            // validator caught is the caller's mistake, not a server fault; the fixed sentence names no table or column.
            DbUpdateException { InnerException: SqlException { Number: 8152 or 2628 or 8115 } } => (StatusCodes.Status400BadRequest, "VALIDATION_FAILED",
                "A value is too long or too large for the field it is stored in. Shorten it and try again."),
            // The framework's text names parameters and DTO types: the caller gets a fixed sentence (ASVS 16.5).
            BadHttpRequestException bad => (bad.StatusCode, "BAD_REQUEST", "The request could not be read. Check the parameters and the body."),
            JsonException => (StatusCodes.Status400BadRequest, "BAD_REQUEST", "The request body is not valid JSON."),
            // A send could not learn whether maintenance began (the document store is unreachable): nothing left (DEV-13).
            Crm.SharedKernel.Operations.MaintenanceStateUnavailableException => (StatusCodes.Status503ServiceUnavailable, "MAINTENANCE_STATE_UNAVAILABLE",
                "Nothing was sent: whether the CRM is in maintenance cannot be read right now. Try again in a minute."),
            _ => null,
        };

        if (mapped is not { } m)
        {
            return false;
        }

        httpContext.Response.StatusCode = m.status;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = { Status = m.status, Title = m.code, Detail = m.detail, Extensions = { ["code"] = m.code } },
        });
    }
}
