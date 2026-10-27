using System.Globalization;
using Crm.Identity.Contracts;

namespace Crm.Integrations.Atera;

/// <summary>
/// The Atera technician a CRM user writes as (M39.2): the one mapped to them, else the technician everyone shares (one Atera
/// account for the whole firm). Only Atera's numeric id can sign a change; a mapping keyed by e-mail cannot.
/// </summary>
internal static class AteraTechnicians
{
    public static bool CanSign(TechnicianListing technician) =>
        long.TryParse(technician.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0;

    public static TechnicianListing? WritesAs(IReadOnlyCollection<TechnicianListing> technicians, Guid? userId) =>
        userId is not { } id ? null
        : technicians.FirstOrDefault(t => t.UserId == id && CanSign(t)) ?? technicians.FirstOrDefault(t => t.Shared && CanSign(t));

    public static async Task<TechnicianListing?> WritesAsAsync(ITechnicianDirectory directory, Guid? userId, CancellationToken ct) =>
        userId is null ? null : WritesAs(await directory.ListAsync(AteraTypes.System, ct), userId);
}
