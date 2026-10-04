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
        services.AddScoped<SlaReportService>();
        // DEV-11: tickets and ticket requests of a person in subject requests, and the retention of the ticket mirror.
        services.AddScoped<Crm.Privacy.Contracts.IPersonalDataContributor, Features.Privacy.ServicePersonalData>();
        services.AddScoped<Crm.Privacy.Contracts.IRetentionContributor, Features.Privacy.TicketMirrorRetention>();
        return services;
    }

    public static IEndpointRouteBuilder MapServiceEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/service").WithTags("Service");

        group.MapGet("/tickets", async (
                Guid? organizationId, Guid? contactId, bool? openOnly, int? days, string? search, int? limit,
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

                var rows = await tickets.OrderByDescending(t => t.IsOpen).ThenByDescending(t => t.CreatedAtSource)
                    .Take(Math.Clamp(limit ?? 100, 1, 500)).ToListAsync(ct);
                var contacts = await customers.GetContactNamesAsync(rows.Where(r => r.ContactId != null).Select(r => r.ContactId!.Value).Distinct().ToList(), ct);
                var organizations = organizationId is null
                    ? await customers.GetOrganizationNamesAsync(rows.Select(r => r.OrganizationId).Distinct().ToList(), ct)
                    : new Dictionary<Guid, string>();
                return Results.Ok(rows.Select(t => new TicketItem(
                    t.Id, t.ExternalId, t.OrganizationId, organizations.GetValueOrDefault(t.OrganizationId), t.ContactId,
                    t.ContactId is { } c ? contacts.GetValueOrDefault(c) ?? t.EndUserName : t.EndUserName, t.Title, t.Status, t.IsOpen, t.Priority, t.Type,
                    t.TechnicianName, t.CreatedAtSource, t.ResolvedAt, t.LastActivityAt, t.Url)).ToList());
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

        group.MapGet("/devices", async (Guid organizationId, DeviceType? type, bool? includeRemoved, ServiceDbContext db, CancellationToken ct) =>
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

                return Results.Ok(await devices.OrderBy(d => d.Type).ThenBy(d => d.MachineName)
                    .Select(d => new DeviceItem(d.Id, d.MachineName, d.Type, d.Os, d.Online, d.LastSeenAt, d.Url, d.RemovedAt)).Take(1000).ToListAsync(ct));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/alerts", async (Guid organizationId, ServiceDbContext db, CancellationToken ct) =>
                Results.Ok(await db.Alerts.AsNoTracking().Where(a => a.OrganizationId == organizationId)
                    .OrderBy(a => a.Severity).ThenByDescending(a => a.CreatedAtSource)
                    .Select(a => new AlertItem(a.Id, a.Severity, a.Title, a.DeviceName, a.CreatedAtSource)).Take(200).ToListAsync(ct)))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/ticket-requests", async (Guid organizationId, ServiceDbContext db, TimeProvider time, CancellationToken ct) =>
            {
                var since = time.GetUtcNow().AddDays(-14);
                return Results.Ok(await db.TicketRequests.AsNoTracking()
                    .Where(r => r.OrganizationId == organizationId && (r.Status != TicketRequestStatus.Created || r.CreatedAt >= since))
                    .OrderByDescending(r => r.CreatedAt)
                    .Select(r => new TicketRequestItem(r.Id, r.Title, r.Status, r.ExternalTicketId, r.Url, r.Error, r.CreatedAt))
                    .Take(20).ToListAsync(ct));
            })
            .RequirePermission(Permissions.ServiceRead);

        group.MapPost("/ticket-requests", async (CreateTicketRequest request, ServiceDbContext db, ICustomersApi customers, CancellationToken ct) =>
            {
                if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
                {
                    return Error.Validation("SRV_UNKNOWN_ORGANIZATION", "The organization does not exist.").ToProblem();
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
