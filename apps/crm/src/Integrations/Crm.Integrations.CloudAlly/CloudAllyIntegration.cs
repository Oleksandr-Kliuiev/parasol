using Crm.Backup.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

public static class CloudAllyTypes
{
    public const string System = BackupSources.CloudAlly;

    /// <summary>A customer account of the partner (CloudAlly's "user"), mapped to an organization.</summary>
    public const string Customer = "Customer";
}

/// <summary>CloudAlly's words in the CRM's vocabulary (M42).</summary>
internal static class CloudAllyMapping
{
    /// <summary>
    /// The service of a task from its source. The reference lists the sources without saying which workload each is; this follows
    /// the names (Exchange tasks are MS365 or O365MAIL and its parts, Teams and groups are backed up together). Anything else is Other.
    /// </summary>
    public static BackupService ServiceOf(string? source)
    {
        var s = source?.Trim().ToUpperInvariant() ?? string.Empty;
        return s switch
        {
            "MS365" or "O365MAIL" or "O365CONTACTS" or "O365CALENDAR" or "O365TASKS" or "O365NOTES" => BackupService.Mail,
            "ONEDRIVE" => BackupService.OneDrive,
            "SHAREPOINT" or "SHAREPOINT_MULTI" => BackupService.SharePoint,
            "MSTEAMS" or "MSGROUPS" or "MS365GROUPS" => BackupService.Teams,
            _ when s.StartsWith("MS365GROUP_", StringComparison.Ordinal) || s.StartsWith("MS365TEAM_", StringComparison.Ordinal) => BackupService.Teams,
            _ => BackupService.Other,
        };
    }

    public static ExternalRecordInput ToRecord(CaAccount account) => new(
        CloudAllyTypes.System,
        CloudAllyTypes.Customer,
        account.Id,
        Name(account),
        account,
        Email: account.Email,
        Domain: DomainOf(account.Email),
        IsGone: account.Status?.ToUpperInvariant() is "DELETED" or "UNSUBSCRIBED");

    public static ExternalOrganizationData ToOrganizationData(CaAccount account) =>
        new(Name(account), null, account.Email, null, null, DomainOf(account.Email) is { } domain ? [domain] : [], null, null, null);

    public static string Name(CaAccount account) =>
        !string.IsNullOrWhiteSpace(account.Name) ? account.Name.Trim() : !string.IsNullOrWhiteSpace(account.Email) ? account.Email.Trim() : account.Id;

    /// <summary>The domain of the account's address, a hint for the mapping screen; none for an address without one.</summary>
    public static string? DomainOf(string? email)
    {
        var at = email?.LastIndexOf('@') ?? -1;
        return at > 0 && at < email!.Length - 1 ? email[(at + 1)..].Trim().ToLowerInvariant() : null;
    }
}

/// <summary>
/// CloudAlly in the CRM's integration list (M42): read-only for the mapping — the partner's customer accounts are mapped to
/// organizations on the mapping screen, since CloudAlly knows no organization number — and the connection test. Calls to CloudAlly
/// run in crm-worker, the only host with the credentials.
/// </summary>
internal sealed class CloudAllyAdapter(IOptions<CloudAllyOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => CloudAllyTypes.System;

    public bool IsEnabled => options.Value.Enabled;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } = [new(CloudAllyTypes.System, CloudAllyTypes.Customer, EntityTypes.Organization)];

    public string? CreateOrganizationOperation => null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == CloudAllyTypes.Customer && ExternalRecordStore.Read<CaAccount>(record) is { } account
            ? CloudAllyMapping.ToOrganizationData(account)
            : null;

    public ExternalContactData? ToContactData(ExternalRecord record) => null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            return new ConnectionTestResult(false, "CloudAlly credentials are not configured on this instance.");
        }

        try
        {
            var client = services.GetRequiredService<ICloudAllyClient>();
            await using var enumerator = client.GetAccountsAsync(cancellationToken).GetAsyncEnumerator(cancellationToken);
            await enumerator.MoveNextAsync();
            return new ConnectionTestResult(true, "Connected to CloudAlly's partner API.");
        }
        catch (Exception ex) when (ex is HttpRequestException or CloudAllyApiException)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }
}

/// <summary>
/// The partner's customer accounts (M42, <c>cloudally-accounts</c>): stored as external records for the mapping screen. CloudAlly
/// has no organization number, so nothing links itself; an account CloudAlly no longer lists, or lists as deleted, is marked gone.
/// </summary>
public sealed class CloudAllyAccountSyncJob(
    ICloudAllyClient client,
    ExternalRecordStore records,
    SyncRunner runner,
    TimeProvider time,
    IOptions<CloudAllyOptions> options,
    ILogger<CloudAllyAccountSyncJob> logger)
{
    public const string JobId = "cloudally-accounts";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("CloudAlly account sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(CloudAllyTypes.System, JobId, async (progress, ct) =>
        {
            var scanStarted = time.GetUtcNow();
            await foreach (var account in client.GetAccountsAsync(ct))
            {
                progress.Read++;
                if ((await records.UpsertAsync(CloudAllyMapping.ToRecord(account), ct)).Changed)
                {
                    progress.Changed++;
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(CloudAllyTypes.System, CloudAllyTypes.Customer, scanStarted, ct);
            progress.Message = $"accounts {progress.Read}, changed {progress.Changed}, no longer in CloudAlly {gone}";
        }, cancellationToken);
    }
}
