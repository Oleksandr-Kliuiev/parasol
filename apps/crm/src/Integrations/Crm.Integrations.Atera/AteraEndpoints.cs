using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.SharedKernel.Application;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>An Atera technician a ticket can be given to (M39.2), with the CRM user they are mapped to, or shared by everyone.</summary>
public sealed record AteraTechnicianItem(string Id, string Name, string? Email, Guid? UserId, bool Shared);

/// <summary>
/// Whom the signed-in person's ticket changes and hours are signed as in Atera: their own technician, the shared one, or no one
/// (<c>Technician</c> null). <c>Enabled</c> is false while the CRM does not work with Atera at all.
/// </summary>
public sealed record MyAteraTechnician(bool Enabled, AteraTechnicianItem? Technician);

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
                    .Where(AteraTechnicians.CanSign)
                    .Select(Item)
                    .ToList()))
            .WithTags("Integrations")
            .RequirePermission(Permissions.ServiceWrite);

        // The account page: one's own technician needs no permission, like one's own preferences (allowlisted in CustomersApiTests).
        app.MapGet("/api/v1/integrations/atera/technicians/me", async (
                ICurrentUser currentUser, ITechnicianDirectory technicians, IOptions<AteraOptions> options, CancellationToken ct) =>
            {
                var technician = await AteraTechnicians.WritesAsAsync(technicians, currentUser.UserId, ct);
                return Results.Ok(new MyAteraTechnician(
                    options.Value.Enabled,
                    technician is null ? null : Item(technician)));
            })
            .WithTags("Integrations");
        return app;
    }

    private static AteraTechnicianItem Item(TechnicianListing t) =>
        new(t.ExternalId, t.Name ?? t.Email ?? $"#{t.ExternalId}", t.Email, t.UserId, t.Shared);
}
