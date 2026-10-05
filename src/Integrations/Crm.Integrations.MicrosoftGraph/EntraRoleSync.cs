using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Who holds which CRM app role right now, read from the CRM's enterprise application (DEV-10): direct assignments and those
/// through an assigned group's direct members — exactly what Entra puts into a sign-in token, which ignores nested groups. A
/// PIM-activated group membership counts while it lasts; when it expires the member is gone from the group, and with it the role.
/// A disabled account holds none: Entra issues it no token, and its assignments outlive the account.
/// </summary>
public interface IGraphRoleAssignmentSource
{
    /// <summary>Role values (e.g. Crm.Finance) per user object id. Users without any assignment, or disabled, are absent.</summary>
    Task<IReadOnlyDictionary<string, IReadOnlyCollection<string>>> GetRoleAssignmentsAsync(string crmAppId, CancellationToken cancellationToken);
}

internal sealed class GraphRoleAssignmentSource(HttpClient http) : IGraphRoleAssignmentSource
{
    private const int MaxPages = 1000;

    public async Task<IReadOnlyDictionary<string, IReadOnlyCollection<string>>> GetRoleAssignmentsAsync(string crmAppId, CancellationToken cancellationToken)
    {
        var principal = (await ReadPagesAsync<GraphServicePrincipal>(
                $"servicePrincipals?$filter=appId eq '{Uri.EscapeDataString(crmAppId)}'&$select=id,appRoles", cancellationToken))
            .SingleOrDefault() ?? throw new InvalidOperationException("The CRM application has no service principal in this tenant.");
        // A disabled role is no longer issued in tokens, so it is no longer held.
        var roleValues = principal.AppRoles.Where(r => r.IsEnabled != false && !string.IsNullOrWhiteSpace(r.Value)).ToDictionary(r => r.Id, r => r.Value!);

        var assignments = await ReadPagesAsync<GraphAppRoleAssignment>(
            $"servicePrincipals/{principal.Id}/appRoleAssignedTo?$select=principalId,principalType,appRoleId&$top=999", cancellationToken);
        var roles = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var groupMembers = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var assignment in assignments)
        {
            if (!roleValues.TryGetValue(assignment.AppRoleId, out var role))
            {
                continue;
            }

            IReadOnlyList<string> users;
            if (string.Equals(assignment.PrincipalType, "User", StringComparison.OrdinalIgnoreCase))
            {
                users = [assignment.PrincipalId];
            }
            else if (string.Equals(assignment.PrincipalType, "Group", StringComparison.OrdinalIgnoreCase))
            {
                if (!groupMembers.TryGetValue(assignment.PrincipalId, out var members))
                {
                    // Direct members only: Entra does not extend a group's app-role assignment to nested groups.
                    members = (await ReadPagesAsync<GraphDirectoryObject>(
                            $"groups/{assignment.PrincipalId}/members/microsoft.graph.user?$select=id&$top=999", cancellationToken))
                        .Select(m => m.Id).ToList();
                    groupMembers[assignment.PrincipalId] = members;
                }

                users = members;
            }
            else
            {
                continue;
            }

            foreach (var user in users)
            {
                if (!roles.TryGetValue(user, out var held))
                {
                    roles[user] = held = new HashSet<string>(StringComparer.Ordinal);
                }

                held.Add(role);
            }
        }

        // Disabled before the hourly user sync marks the account inactive: its privileges end with this run, not an hour later.
        var disabled = (await ReadPagesAsync<GraphDirectoryObject>("users?$filter=accountEnabled eq false&$select=id&$top=999", cancellationToken))
            .Select(u => u.Id).ToHashSet(StringComparer.Ordinal);
        return roles.Where(r => !disabled.Contains(r.Key))
            .ToDictionary(r => r.Key, r => (IReadOnlyCollection<string>)r.Value, StringComparer.Ordinal);
    }

    private async Task<List<T>> ReadPagesAsync<T>(string url, CancellationToken cancellationToken)
    {
        var items = new List<T>();
        for (var page = 0; page < MaxPages && url is not null; page++)
        {
            using var response = await http.GetAsync(url, cancellationToken);
            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadFromJsonAsync<GraphPage<T>>(cancellationToken)
                       ?? throw new InvalidOperationException("Empty page from Microsoft Graph.");
            items.AddRange(body.Value);
            url = body.NextLink is { } next ? GraphLinks.Require(http.BaseAddress, next) : null!;
        }

        return items;
    }

    private sealed record GraphPage<T>(
        [property: JsonPropertyName("value")] IReadOnlyList<T> Value,
        [property: JsonPropertyName("@odata.nextLink")] string? NextLink);

    private sealed record GraphServicePrincipal(
        [property: JsonPropertyName("id")] string Id,
        [property: JsonPropertyName("appRoles")] IReadOnlyList<GraphAppRole> AppRoles);

    private sealed record GraphAppRole(
        [property: JsonPropertyName("id")] Guid Id,
        [property: JsonPropertyName("value")] string? Value,
        [property: JsonPropertyName("isEnabled")] bool? IsEnabled);

    private sealed record GraphAppRoleAssignment(
        [property: JsonPropertyName("principalId")] string PrincipalId,
        [property: JsonPropertyName("principalType")] string PrincipalType,
        [property: JsonPropertyName("appRoleId")] Guid AppRoleId);

    private sealed record GraphDirectoryObject([property: JsonPropertyName("id")] string Id);
}

/// <summary>
/// Every two minutes, the CRM roles every user holds in Entra ID now (DEV-10): sessions take their roles from what this records,
/// so a removed assignment, a group left or an expired PIM activation ends the privilege in every replica within about two and
/// a half minutes. A run writes one confirmation for the tenant and changes only users whose roles changed. A failed run
/// records nothing — the last confirmation ages, and privileged actions stop after five minutes.
/// </summary>
public sealed class EntraRoleSyncJob(
    IGraphRoleAssignmentSource source,
    IUserRoleDirectory directory,
    SyncRunner runner,
    TimeProvider time,
    IOptions<GraphOptions> options,
    ILogger<EntraRoleSyncJob> logger)
{
    public const string JobId = "entra-role-sync";

    /// <summary>
    /// Every run that fails or changes roles is in the integration log; of the unchanged ones, one an hour. The confirmation
    /// itself is the tenant's row in identity, written by every successful run.
    /// </summary>
    public static readonly TimeSpan QuietFor = TimeSpan.FromHours(1);

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var graph = options.Value;
        if (!graph.Enabled || string.IsNullOrWhiteSpace(graph.TenantId) || string.IsNullOrWhiteSpace(graph.CrmAppId))
        {
            logger.LogInformation("Entra role sync skipped: Microsoft Graph or the CRM application id is not configured.");
            return;
        }

        // DEV-13: it keeps running during read-only maintenance. A role taken away still ends within minutes, and the operators'
        // privileged actions (lifting the maintenance, applying a reconciliation) keep their fresh confirmation.
        using var directorySync = MaintenanceScope.AllowWrites("directory-sync");
        await runner.RunAsync(EntraUserSyncJob.System, JobId, async (progress, ct) =>
        {
            // Confirmed as of the moment the reading began: a sign-in after that keeps its own, later confirmation.
            var startedAt = time.GetUtcNow();
            var assignments = await source.GetRoleAssignmentsAsync(graph.CrmAppId!, ct);
            var applied = await directory.ApplyAsync(graph.TenantId!, assignments, startedAt, ct);
            progress.Read = assignments.Count;
            progress.Changed = applied.Changed;
            progress.Message = applied.Superseded
                ? $"{assignments.Count} users with CRM roles in Entra ID; discarded, a later reading was applied first"
                : $"{assignments.Count} users with CRM roles in Entra ID; {applied.Users} CRM users confirmed, {applied.Changed} changed";
        }, cancellationToken, quietFor: QuietFor);
    }
}
