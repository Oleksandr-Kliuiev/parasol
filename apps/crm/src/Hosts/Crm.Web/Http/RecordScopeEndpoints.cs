using Crm.Authorization;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Http;
using Crm.Infrastructure.Security;
using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.Web.Http;

/// <summary>
/// The record scope report (DEV-09, runbook 11): per kind of scoped record, which roles see all of it, which see only their
/// own or assigned records, and how the records are spread over people — so owners and assignments are put right before the
/// Restricted mode reaches data, instead of everyone being given everything to cover a gap.
/// </summary>
internal static class RecordScopeEndpoints
{
    public static IEndpointRouteBuilder MapRecordScopeEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/admin/record-scope", async (
                IEnumerable<IRecordScopeReporter> reporters, IUserDirectory users, IOptions<RecordScopeOptions> options, CancellationToken ct) =>
            {
                var sections = new List<RecordScopeSectionDto>();
                foreach (var reporter in reporters.OrderBy(r => r.Kind, StringComparer.Ordinal))
                {
                    var counts = await reporter.CountAsync(ct);
                    var people = await users.GetUsersAsync(counts.Assignees.Keys.ToList(), ct);
                    sections.Add(new RecordScopeSectionDto(
                        reporter.Kind,
                        reporter.EveryRecordPermission,
                        RolesWhere(held => held.Contains(reporter.EveryRecordPermission)),
                        RolesWhere(held => held.Contains(reporter.ReadPermission) && !held.Contains(reporter.EveryRecordPermission)),
                        counts.Total,
                        counts.WithoutAssignee,
                        counts.Assignees
                            .Select(a => people.TryGetValue(a.Key, out var person)
                                ? new RecordScopeAssigneeDto(a.Key, person.DisplayName, person.IsActive, a.Value)
                                : new RecordScopeAssigneeDto(a.Key, null, false, a.Value))
                            .OrderByDescending(a => a.Records)
                            .ThenBy(a => a.Name, StringComparer.CurrentCulture)
                            .ToList()));
                }

                return Results.Ok(new RecordScopeReportDto(options.Value.RecordScope, sections));
            })
            .RequirePermission(Permissions.AuditRead);
        return app;
    }

    private static List<string> RolesWhere(Func<IReadOnlySet<string>, bool> condition) =>
        CrmRoles.All.Where(role => condition(Permissions.ForRoles([role]))).Order(StringComparer.Ordinal).ToList();
}

public sealed record RecordScopeReportDto(RecordScopeMode Mode, IReadOnlyList<RecordScopeSectionDto> Sections);

/// <param name="RolesSeeingAll">Roles that see every record of the kind.</param>
/// <param name="RolesLimited">Roles that see the kind but, in the Restricted mode, only their own or assigned records.</param>
public sealed record RecordScopeSectionDto(
    string Kind,
    string EveryRecordPermission,
    IReadOnlyList<string> RolesSeeingAll,
    IReadOnlyList<string> RolesLimited,
    int Total,
    int WithoutAssignee,
    IReadOnlyList<RecordScopeAssigneeDto> Assignees);

/// <param name="Active">False for a deactivated or unknown user: their records are seen only by roles that see everything.</param>
public sealed record RecordScopeAssigneeDto(Guid UserId, string? Name, bool Active, int Records);
