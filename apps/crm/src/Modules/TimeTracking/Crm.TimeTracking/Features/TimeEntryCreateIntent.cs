using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Crm.TimeTracking.Features;

internal static class TimeEntryCreateIntent
{
    internal static string Hash(TimeEntryRequest request, Guid technicianId)
    {
        // Field order is deliberate. Use the domain's text/decimal normalization, and exclude caller ticket text/number
        // when a verified mirror GUID controls those values. A later mirror title change cannot change the original intent.
        var canonical = new
        {
            request.OrganizationId, TechnicianId = technicianId, WorkDate = request.WorkDate.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            Hours = decimal.Round(request.Hours, 2).ToString("0.##", CultureInfo.InvariantCulture),
            WorkType = Clean(request.WorkType), request.Billable, request.Onsite, request.AfterHours, Description = Clean(request.Description),
            request.ProjectId, request.TicketId, request.SourceActivityId,
            ExternalTicketId = request.TicketId is null ? request.ExternalTicketId : null,
            TicketTitle = request.TicketId is null ? Clean(request.TicketTitle) : null,
        };
        return Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(canonical)));
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
