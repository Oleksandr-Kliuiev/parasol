using System.Diagnostics.Metrics;
using System.Security.Claims;
using Crm.Authorization;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Routing;

namespace Crm.Web.Http;

/// <summary>
/// Security events (ASVS 16): refused requests, sign-in problems, rate-limit rejections. One category (<c>Crm.Security</c>) and
/// a counter with a single low-cardinality tag, so alerts need no parsing. A message carries ids and route templates only —
/// never a query string, a token, a name, an amount or the text of an exception from a provider.
/// </summary>
internal static partial class SecurityLog
{
    public const string Category = "Crm.Security";
    private static readonly Meter Meter = new("Crm.Security");
    private static readonly Counter<long> Events = Meter.CreateCounter<long>("crm.security.events", description: "Refused requests and sign-in problems, by kind");

    public static ILogger For(HttpContext context) =>
        context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(Category);

    /// <summary>The matched route template (<c>/api/v1/billing/runs/{id}</c>), never the path with its values or the query.</summary>
    public static string RouteOf(HttpContext context) =>
        (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "(unmatched)";

    public static Guid? UserOf(HttpContext context) =>
        Guid.TryParse(context.User.FindFirstValue(CrmClaimTypes.UserId), out var id) ? id : null;

    public static void Count(string kind) => Events.Add(1, new KeyValuePair<string, object?>("kind", kind));

    public static void Forbidden(this ILogger logger, HttpContext context, string reason)
    {
        Count("forbidden");
        ForbiddenMessage(logger, UserOf(context), context.Request.Method, RouteOf(context), reason);
    }

    public static void Unauthenticated(this ILogger logger, HttpContext context)
    {
        Count("unauthenticated");
        UnauthenticatedMessage(logger, context.Request.Method, RouteOf(context));
    }

    public static void CsrfRefused(this ILogger logger, HttpContext context)
    {
        Count("csrf_refused");
        CsrfRefusedMessage(logger, UserOf(context), context.Request.Method, RouteOf(context));
    }

    public static void RateLimited(this ILogger logger, HttpContext context)
    {
        Count("rate_limited");
        RateLimitedMessage(logger, UserOf(context), context.Request.Method, RouteOf(context));
    }

    public static void BiTokenRejected(this ILogger logger, string reason)
    {
        Count("bi_token_rejected");
        BiTokenRejectedMessage(logger, reason);
    }

    public static void BiDenied(this ILogger logger, string? client, string reason)
    {
        Count("bi_denied");
        BiDeniedMessage(logger, client ?? "(none)", reason);
    }

    public static void SignInFailed(this ILogger logger, string error)
    {
        Count("sign_in_failed");
        SignInFailedMessage(logger, error);
    }

    public static void RemoteSignOutApplied(this ILogger logger, int ended) => RemoteSignOutAppliedMessage(logger, ended);

    public static void RemoteSignOutIgnored(this ILogger logger, string reason)
    {
        Count("remote_sign_out_ignored");
        RemoteSignOutIgnoredMessage(logger, reason);
    }

    [LoggerMessage(EventId = 1001, Level = LogLevel.Warning, Message = "Access denied: user {UserId}, {Method} {Route}, reason {Reason}")]
    private static partial void ForbiddenMessage(ILogger logger, Guid? userId, string method, string route, string reason);

    [LoggerMessage(EventId = 1002, Level = LogLevel.Information, Message = "Unauthenticated request refused: {Method} {Route}")]
    private static partial void UnauthenticatedMessage(ILogger logger, string method, string route);

    [LoggerMessage(EventId = 1003, Level = LogLevel.Warning, Message = "State-changing request without the CSRF header refused: user {UserId}, {Method} {Route}")]
    private static partial void CsrfRefusedMessage(ILogger logger, Guid? userId, string method, string route);

    [LoggerMessage(EventId = 1004, Level = LogLevel.Warning, Message = "Rate limit rejected a request: user {UserId}, {Method} {Route}")]
    private static partial void RateLimitedMessage(ILogger logger, Guid? userId, string method, string route);

    [LoggerMessage(EventId = 1005, Level = LogLevel.Warning, Message = "BI bearer token rejected: {Reason}")]
    private static partial void BiTokenRejectedMessage(ILogger logger, string reason);

    [LoggerMessage(EventId = 1006, Level = LogLevel.Warning, Message = "BI access denied: client {Client}, reason {Reason}")]
    private static partial void BiDeniedMessage(ILogger logger, string client, string reason);

    [LoggerMessage(EventId = 1007, Level = LogLevel.Warning, Message = "Sign-in failed: {Error}")]
    private static partial void SignInFailedMessage(ILogger logger, string error);

    [LoggerMessage(EventId = 1008, Level = LogLevel.Information, Message = "Front-channel logout ended {Ended} session(s)")]
    private static partial void RemoteSignOutAppliedMessage(ILogger logger, int ended);

    [LoggerMessage(EventId = 1009, Level = LogLevel.Warning, Message = "Front-channel logout ignored: {Reason}")]
    private static partial void RemoteSignOutIgnoredMessage(ILogger logger, string reason);
}
