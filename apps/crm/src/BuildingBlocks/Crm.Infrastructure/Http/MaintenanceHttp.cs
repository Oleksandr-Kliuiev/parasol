using System.Globalization;
using Crm.SharedKernel.Operations;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace Crm.Infrastructure.Http;

/// <summary>An endpoint that keeps working while the CRM is read-only for maintenance (DEV-13): the operator's own controls.</summary>
public sealed class AllowedInMaintenanceMetadata;

public static class MaintenanceHttp
{
    public const string ReadOnlyCode = "MAINTENANCE_READ_ONLY";

    public static TBuilder AllowedInMaintenance<TBuilder>(this TBuilder builder)
        where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(new AllowedInMaintenanceMetadata());

    /// <summary>The one answer to anything that would change data during maintenance: 503, coded, with when it began.</summary>
    public static async Task WriteReadOnlyAsync(HttpContext context, MaintenanceState state)
    {
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        context.Response.Headers.RetryAfter = "300";
        var since = state.At == DateTimeOffset.MinValue ? null : state.At.ToString("O", CultureInfo.InvariantCulture);
        await context.Response.WriteAsJsonAsync(new
        {
            title = ReadOnlyCode,
            status = StatusCodes.Status503ServiceUnavailable,
            code = ReadOnlyCode,
            detail = "The CRM is read-only for maintenance. Reading works; nothing can be changed until the maintenance ends.",
            since,
        }, options: null, contentType: "application/problem+json");
    }
}
