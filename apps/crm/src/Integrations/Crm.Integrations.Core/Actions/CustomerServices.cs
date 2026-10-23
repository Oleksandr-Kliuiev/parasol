using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Http;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Actions;

/// <summary>
/// The record of a vendor the customer is linked to: its id, its name there once a read stored the record (a link made before the
/// vendor's records were read has none yet), and when and how the link was made.
/// </summary>
public sealed record CustomerServiceLink(string ExternalId, string? Name, DateTimeOffset LinkedAt, LinkMethod Method);

/// <summary>
/// One vendor the customer can be connected to (M43, the "Connect services" wizard): whether its integration is on here, the record the
/// customer is linked to, and otherwise whether this person may create it now. <paramref name="Block"/> is the code of what refuses the
/// creation (the integration is off, creating is not switched on, the allow-list, no access) — the same codes the preview gives.
/// <paramref name="Defaults"/> are the parameters the wizard starts from; <paramref name="ConsoleUrl"/> leads to the vendor's console for
/// what its API cannot do, when configured.
/// </summary>
public sealed record CustomerService(
    string System,
    string Kind,
    bool Enabled,
    CustomerServiceLink? Link,
    string? Block,
    bool Simulated,
    IReadOnlyDictionary<string, string?> Defaults,
    string? ConsoleUrl);

public sealed record CustomerServices(Guid OrganizationId, string Name, IReadOnlyList<CustomerService> Services);

/// <summary>
/// What the wizard starts from (M43): for every vendor whose integration can create the customer — Atera, Huntress, CloudAlly — the
/// link the customer has there, or whether the creation would be let through now. From saved data and switches only: nothing is asked
/// of a vendor, so it answers in crm-web.
/// </summary>
public sealed class CustomerServiceReader(
    ICustomersApi customers,
    IntegrationDbContext db,
    IEnumerable<IVendorActionHandler> handlers,
    IEnumerable<IVendorActionGate> gates,
    ICurrentUser user)
{
    /// <summary>The order the wizard takes them in: monitoring first (Huntress is installed through it), then security, then backups.</summary>
    private static readonly string[] Order = ["atera", "huntress", "cloudally"];

    public async Task<CustomerServices?> ReadAsync(Guid organizationId, CancellationToken ct)
    {
        if (await customers.GetOrganizationForSyncAsync(organizationId, ct) is not { IsDeleted: false } organization)
        {
            return null;
        }

        var creators = handlers.OfType<CustomerCreationAction>()
            .OrderBy(h => Array.IndexOf(Order, h.System) is var i and >= 0 ? i : Order.Length).ThenBy(h => h.System, StringComparer.Ordinal)
            .ToList();
        var links = await db.ExternalLinks.AsNoTracking()
            .Where(l => l.EntityType == EntityTypes.Organization && l.EntityId == organizationId)
            .ToListAsync(ct);
        var linkedIds = links.Select(l => l.ExternalId).ToList();
        var names = await db.ExternalRecords.AsNoTracking()
            .Where(r => linkedIds.Contains(r.ExternalId))
            .Select(r => new { r.System, r.ExternalType, r.ExternalId, r.DisplayName })
            .ToListAsync(ct);

        var services = new List<CustomerService>();
        foreach (var creator in creators)
        {
            var switches = gates.SingleOrDefault(g => g.System == creator.System)?.Read();
            var link = links.FirstOrDefault(l => l.System == creator.System && l.ExternalType == creator.ExternalType);
            CustomerServiceLink? linked = link is null
                ? null
                : new CustomerServiceLink(link.ExternalId,
                    names.FirstOrDefault(n => n.System == link.System && n.ExternalType == link.ExternalType && n.ExternalId == link.ExternalId)?.DisplayName,
                    link.LinkedAt, link.Method);
            var block = linked is not null ? null
                : !user.HasPermission(creator.Permission) ? "VND_FORBIDDEN"
                : VendorActionRules.CheckSwitches(switches, creator.Kind, null, credentials: false, organizationId)?.Code;
            services.Add(new CustomerService(
                creator.System, creator.Kind, switches?.Enabled == true, linked, block, switches?.DryRun == true, creator.Defaults(organization),
                creator.ConsoleUrl));
        }

        return new CustomerServices(organization.Id, organization.Name, services);
    }
}

/// <summary><c>GET /api/v1/integrations/organizations/{id}/services</c> (M43): what the "Connect services" wizard starts from.</summary>
public static class CustomerServiceEndpoints
{
    public static IEndpointRouteBuilder MapCustomerServiceEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/integrations/organizations/{organizationId:guid}/services", async (
                Guid organizationId, CustomerServiceReader reader, HttpContext http, CancellationToken ct) =>
            {
                http.Response.Headers.CacheControl = "no-store";
                return await reader.ReadAsync(organizationId, ct) is { } services
                    ? Results.Ok(services)
                    : Error.NotFound("INT_ORGANIZATION_NOT_FOUND", "The organization was not found.").ToProblem();
            })
            .WithTags("Integrations")
            .RequirePermission(Permissions.IntegrationsManage);
        return app;
    }
}
