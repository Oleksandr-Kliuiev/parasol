using System.Globalization;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Http;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Service;

public sealed record TicketItem(
    Guid Id,
    long ExternalId,
    Guid OrganizationId,
    string? OrganizationName,
    Guid? ContactId,
    string? ContactName,
    string Title,
    string Status,
    bool IsOpen,
    string? Priority,
    string? Type,
    string? TechnicianName,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ResolvedAt,
    DateTimeOffset? LastActivityAt,
    string? Url);

public sealed record DeviceItem(Guid Id, string MachineName, DeviceType Type, string? Os, bool Online, DateTimeOffset? LastSeenAt, string? Url, DateTimeOffset? RemovedAt);

public sealed record AlertItem(Guid Id, AlertSeverity Severity, string Title, string? DeviceName, DateTimeOffset CreatedAt);

public sealed record ServiceSummary(
    int OpenTickets,
    int TicketsLast90Days,
    IReadOnlyDictionary<DeviceType, int> Devices,
    int DevicesOnline,
    int CriticalAlerts,
    int WarningAlerts,
    DateTimeOffset? LastSyncedAt);

public sealed record CreateTicketRequest(Guid OrganizationId, Guid? ContactId, string Title, string Description, string Priority, string Type);

public sealed record TicketRequestItem(Guid Id, string Title, TicketRequestStatus Status, long? ExternalTicketId, string? Url, string? Error, DateTimeOffset CreatedAt);

internal sealed class CreateTicketRequestValidator : AbstractValidator<CreateTicketRequest>
{
    public static readonly string[] Priorities = ["Low", "Medium", "High", "Critical"];
    public static readonly string[] Types = ["Problem", "Bug", "Request", "Incident", "Change"];

    public CreateTicketRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.ContactId).NotEmpty().WithMessage("Choose the contact the ticket is for.");
        RuleFor(x => x.Title).NotEmpty().MaximumLength(256);
        RuleFor(x => x.Description).NotEmpty().MaximumLength(8000);
        RuleFor(x => x.Priority).Must(p => Priorities.Contains(p));
        RuleFor(x => x.Type).Must(t => Types.Contains(t));
    }
}

public static class ServiceModule
{
    public static IServiceCollection AddServiceModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<ServiceDbContext>(configuration);
        services.AddModuleServices(typeof(ServiceModule).Assembly);
        services.AddScoped<IServiceApi, ServiceApi>();
        services.AddScoped<ITicketWorkApi, TicketWorkApi>();
        services.AddScoped<SlaReportService>();
        // DEV-11: tickets and ticket requests of a person in subject requests, and the retention of the ticket mirror.
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor, Features.Privacy.ServicePersonalData>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, Features.Privacy.TicketMirrorRetention>();
        return services;
    }

    public static IEndpointRouteBuilder MapServiceEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/service").WithTags("Service");

        group.MapGet("/work-tickets", async (Guid organizationId, int? limit, string? cursor, ITicketWorkApi tickets, CancellationToken ct) =>
                (await tickets.ListAsync(organizationId, limit, cursor, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/tickets", async (
                Guid? organizationId, Guid? contactId, bool? openOnly, int? days, string? search, int? limit, string? cursor,
                ServiceDbContext db, ICustomersApi customers, TimeProvider time, CancellationToken ct) =>
            {
                var tickets = db.Tickets.AsNoTracking();
                if (organizationId is { } org)
                {
                    tickets = tickets.Where(t => t.OrganizationId == org);
                }

                if (contactId is { } contact)
                {
                    tickets = tickets.Where(t => t.ContactId == contact);
                }

                // BR-SRV-01: recent 90 days by default; open tickets are always shown.
                var since = time.GetUtcNow().AddDays(-Math.Clamp(days ?? 90, 1, 3650));
                tickets = openOnly == true ? tickets.Where(t => t.IsOpen) : tickets.Where(t => t.IsOpen || t.CreatedAtSource >= since);
                if (!string.IsNullOrWhiteSpace(search))
                {
                    var term = search.Trim();
                    tickets = long.TryParse(term, out var number)
                        ? tickets.Where(t => t.ExternalId == number)
                        : tickets.Where(t => t.Title.Contains(term));
                }

                // Open first, newest first, then id (DEV-12): a page per request and the count of all, never a silent cut.
                var total = await tickets.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after &&
                    DateTimeOffset.TryParseExact(after.Then, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
                {
                    var rank = after.SortKey == "0" ? 0 : 1;
                    tickets = tickets.Where(t => (t.IsOpen ? 0 : 1) > rank ||
                        ((t.IsOpen ? 0 : 1) == rank && (t.CreatedAtSource < created || (t.CreatedAtSource == created && t.Id.CompareTo(after.Id) < 0))));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await tickets.OrderBy(t => t.IsOpen ? 0 : 1).ThenByDescending(t => t.CreatedAtSource).ThenByDescending(t => t.Id)
                    .Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                var last = rows.LastOrDefault();
                var next = page.Count > take && last is not null
                    ? new KeysetCursor(last.IsOpen ? "0" : "1", last.Id, last.CreatedAtSource.ToString("O", CultureInfo.InvariantCulture)).Encode()
                    : null;
                var contacts = await customers.GetContactNamesAsync(rows.Where(r => r.ContactId != null).Select(r => r.ContactId!.Value).Distinct().ToList(), ct);
                var organizations = organizationId is null
                    ? await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct)
                    : new Dictionary<Guid, string>();
                return Results.Ok(new PagedResult<TicketItem>(rows.Select(t => new TicketItem(
                    t.Id, t.ExternalId, t.OrganizationId, organizations.GetValueOrDefault(t.OrganizationId), t.ContactId,
                    t.ContactId is { } c ? contacts.GetValueOrDefault(c) ?? t.EndUserName : t.EndUserName, t.Title, t.Status, t.IsOpen, t.Priority, t.Type,
                    t.TechnicianName, t.CreatedAtSource, t.ResolvedAt, t.LastActivityAt, t.Url)).ToList(), next, total));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/organizations/{organizationId:guid}/summary", async (Guid organizationId, ServiceDbContext db, TimeProvider time, CancellationToken ct) =>
            {
                var since = time.GetUtcNow().AddDays(-90);
                var devices = await db.Devices.AsNoTracking().Where(d => d.OrganizationId == organizationId && d.RemovedAt == null)
                    .GroupBy(d => d.Type).Select(g => new { g.Key, Count = g.Count(), Online = g.Count(d => d.Online) }).ToListAsync(ct);
                var alerts = await db.Alerts.AsNoTracking().Where(a => a.OrganizationId == organizationId)
                    .GroupBy(a => a.Severity).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(ct);
                var tickets = db.Tickets.AsNoTracking().Where(t => t.OrganizationId == organizationId);
                return Results.Ok(new ServiceSummary(
                    await tickets.CountAsync(t => t.IsOpen, ct),
                    await tickets.CountAsync(t => t.CreatedAtSource >= since, ct),
                    devices.ToDictionary(d => d.Key, d => d.Count),
                    devices.Sum(d => d.Online),
                    alerts.FirstOrDefault(a => a.Key == AlertSeverity.Critical)?.Count ?? 0,
                    alerts.FirstOrDefault(a => a.Key == AlertSeverity.Warning)?.Count ?? 0,
                    await tickets.MaxAsync(t => (DateTimeOffset?)t.SyncedAt, ct)));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/devices", async (Guid organizationId, DeviceType? type, bool? includeRemoved, int? limit, string? cursor, ServiceDbContext db, CancellationToken ct) =>
            {
                var devices = db.Devices.AsNoTracking().Where(d => d.OrganizationId == organizationId);
                if (includeRemoved != true)
                {
                    devices = devices.Where(d => d.RemovedAt == null);
                }

                if (type is { } t)
                {
                    devices = devices.Where(d => d.Type == t);
                }

                // By machine name, then id (DEV-12); the counts per type come from the summary, which counts every device.
                var total = await devices.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after)
                {
                    devices = devices.Where(d => d.MachineName.CompareTo(after.SortKey) > 0 || (d.MachineName == after.SortKey && d.Id.CompareTo(after.Id) > 0));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await devices.OrderBy(d => d.MachineName).ThenBy(d => d.Id)
                    .Select(d => new DeviceItem(d.Id, d.MachineName, d.Type, d.Os, d.Online, d.LastSeenAt, d.Url, d.RemovedAt)).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<DeviceItem>(
                    rows, page.Count > take ? new KeysetCursor(rows[^1].MachineName, rows[^1].Id).Encode() : null, total));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/alerts", async (Guid organizationId, int? limit, string? cursor, ServiceDbContext db, CancellationToken ct) =>
            {
                // Critical first, newest first, then id (DEV-12).
                var alerts = db.Alerts.AsNoTracking().Where(a => a.OrganizationId == organizationId);
                var total = await alerts.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after &&
                    DateTimeOffset.TryParseExact(after.Then, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
                {
                    var rank = after.SortKey == "0" ? 0 : 1;
                    alerts = alerts.Where(a => (a.Severity == AlertSeverity.Critical ? 0 : 1) > rank ||
                        ((a.Severity == AlertSeverity.Critical ? 0 : 1) == rank && (a.CreatedAtSource < created || (a.CreatedAtSource == created && a.Id.CompareTo(after.Id) < 0))));
                }

                var take = KeysetCursor.ClampLimit(limit);
                var page = await alerts.OrderBy(a => a.Severity == AlertSeverity.Critical ? 0 : 1).ThenByDescending(a => a.CreatedAtSource).ThenByDescending(a => a.Id)
                    .Select(a => new AlertItem(a.Id, a.Severity, a.Title, a.DeviceName, a.CreatedAtSource)).Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<AlertItem>(
                    rows,
                    page.Count > take
                        ? new KeysetCursor(rows[^1].Severity == AlertSeverity.Critical ? "0" : "1", rows[^1].Id, rows[^1].CreatedAt.ToString("O", CultureInfo.InvariantCulture)).Encode()
                        : null,
                    total));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/ticket-requests", async (Guid organizationId, bool? attentionOnly, int? limit, string? cursor, ServiceDbContext db, TimeProvider time, CancellationToken ct) =>
            {
                // The organization's banner asks only for what still needs attention (pending or failed), so its count is honest.
                var since = attentionOnly == true ? DateTimeOffset.MaxValue : time.GetUtcNow().AddDays(-14);
                var requests = db.TicketRequests.AsNoTracking()
                    .Where(r => r.OrganizationId == organizationId && (r.Status != TicketRequestStatus.Created || r.CreatedAt >= since));
                var total = await requests.CountAsync(ct);
                if (KeysetCursor.Decode(cursor) is { } after &&
                    DateTimeOffset.TryParseExact(after.SortKey, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var created))
                {
                    requests = requests.Where(r => r.CreatedAt < created || (r.CreatedAt == created && r.Id.CompareTo(after.Id) < 0));
                }

                var take = Math.Clamp(limit ?? 20, 1, KeysetCursor.MaxLimit);
                var page = await requests.OrderByDescending(r => r.CreatedAt).ThenByDescending(r => r.Id)
                    .Select(r => new TicketRequestItem(r.Id, r.Title, r.Status, r.ExternalTicketId, r.Url, r.Error, r.CreatedAt))
                    .Take(take + 1).ToListAsync(ct);
                var rows = page.Take(take).ToList();
                return Results.Ok(new PagedResult<TicketRequestItem>(
                    rows, page.Count > take ? new KeysetCursor(rows[^1].CreatedAt.ToString("O", CultureInfo.InvariantCulture), rows[^1].Id).Encode() : null, total));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapPost("/ticket-requests", async (CreateTicketRequest request, ServiceDbContext db, ICustomersApi customers, CancellationToken ct) =>
            {
                if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
                {
                    return Error.Validation("SRV_UNKNOWN_ORGANIZATION", "The organization does not exist.").ToProblem();
                }

                if (request.ContactId is not { } contactId ||
                    await customers.GetContactForSyncAsync(contactId, ct) is not { } contact || !contact.IsUsableFor(request.OrganizationId))
                {
                    return Error.Validation("SRV_CONTACT_UNAVAILABLE", "Choose an active contact of this customer.",
                        new Dictionary<string, object?>
                        {
                            ["errors"] = new Dictionary<string, string[]>
                            {
                                [nameof(request.ContactId)] = ["Choose an active contact of this customer."],
                            },
                        }).ToProblem();
                }

                var ticketRequest = TicketRequest.Create(request.OrganizationId, request.ContactId, request.Title, request.Description, request.Priority, request.Type);
                db.TicketRequests.Add(ticketRequest);
                await db.SaveChangesAsync(ct);
                return Results.Accepted(value: new TicketRequestItem(ticketRequest.Id, ticketRequest.Title, ticketRequest.Status, null, null, null, ticketRequest.CreatedAt));
            })
            .Validate<CreateTicketRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        // FR-SRV-04: response and resolution against the SLA of the customer's contract, in support hours only.
        group.MapGet("/sla-report", async (int year, int month, Guid? organizationId, SlaReportService service, CancellationToken ct) =>
                (await service.GetAsync(year, month, organizationId, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/ticket-options", () => Results.Ok(new { priorities = CreateTicketRequestValidator.Priorities, types = CreateTicketRequestValidator.Types }))
            .RequirePermission(Permissions.ServiceRead);

        return app;
    }
}
