using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Hourly incremental user synchronization from Entra ID (BR-AUTH-05): disabled or removed accounts are deactivated in the CRM,
/// which blocks their sessions within a minute, and profile fields (name, department, title) are refreshed.
/// </summary>
public sealed class EntraUserSyncJob(
    IGraphUserSource source,
    IUserDirectorySync directory,
    SyncRunner runner,
    IOptions<GraphOptions> options,
    ILogger<EntraUserSyncJob> logger)
{
    public const string JobId = "entra-user-sync";
    public const string System = "microsoft-graph";
    private const string Stream = "users-delta";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var graph = options.Value;
        if (!graph.Enabled || string.IsNullOrWhiteSpace(graph.TenantId))
        {
            logger.LogInformation("Entra user sync skipped: Microsoft Graph integration is disabled.");
            return;
        }

        await runner.RunAsync(System, JobId, async (progress, ct) =>
        {
            var deltaLink = await runner.GetCursorAsync(System, Stream, ct);
            GraphDeltaResult result;
            try
            {
                result = await source.GetUserChangesAsync(deltaLink, ct);
            }
            catch (DeltaTokenExpiredException)
            {
                logger.LogWarning("Graph delta token expired; running a full user synchronization.");
                result = await source.GetUserChangesAsync(null, ct);
            }

            var changes = result.Users.Select(u => new DirectoryUserChange(
                    graph.TenantId!, u.Id, u.Removed is not null, u.AccountEnabled, u.DisplayName, u.UserPrincipalName, u.Mail, u.Department, u.JobTitle))
                .ToList();
            var applied = await directory.ApplyAsync(changes, ct);
            await runner.SetCursorAsync(System, Stream, result.DeltaLink, ct);

            progress.Read = changes.Count;
            progress.Changed = applied.Updated + applied.Deactivated + applied.Reactivated;
            progress.Message = $"matched {applied.Matched}, updated {applied.Updated}, deactivated {applied.Deactivated}, reactivated {applied.Reactivated}";
        }, cancellationToken);
    }
}
