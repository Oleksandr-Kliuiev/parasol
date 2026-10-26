using System.Globalization;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Crm.Integrations.Atera;

/// <summary>An Atera technician a ticket can be given to (M39.2), with the CRM user they are mapped to.</summary>
public sealed record AteraTechnicianItem(string Id, string Name, string? Email, Guid? UserId);

public static class AteraEndpoints
{
    /// <summary>
    /// The technicians a ticket can be given to: those the CRM has seen on tickets and work hours with Atera's numeric id (a mapping
    /// keyed by e-mail cannot sign a change). Read from the CRM's own records, never from Atera.
    /// </summary>
    public static IEndpointRouteBuilder MapAteraEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/integrations/atera/technicians", async (ITechnicianDirectory technicians, CancellationToken ct) =>
                Results.Ok((await technicians.ListAsync(AteraTypes.System, ct))
                    .Where(t => long.TryParse(t.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0)
                    .Select(t => new AteraTechnicianItem(t.ExternalId, t.Name ?? t.Email ?? $"#{t.ExternalId}", t.Email, t.UserId))
                    .ToList()))
            .WithTags("Integrations")
            .RequirePermission(Permissions.ServiceWrite);
        return app;
    }
}
