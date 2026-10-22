using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

public sealed class CloudAllyApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>
/// CloudAlly's partner API v2 as the CRM uses it (M42): the partner's accounts, their backup tasks with users and sites, the status
/// of every backed-up entity and the bills, and the actions of the action path. Every list is read to its end or throws, so a caller
/// never mistakes part of a list for all of it.
/// </summary>
public interface ICloudAllyClient
{
    IAsyncEnumerable<CaAccount> GetAccountsAsync(CancellationToken cancellationToken);

    /// <summary>Every task of every account of the partner; only the backup tasks matter to the CRM.</summary>
    IAsyncEnumerable<CaTask> GetTasksAsync(CancellationToken cancellationToken);

    /// <summary>The status of every backed-up entity of every account.</summary>
    IAsyncEnumerable<CaEntityStatus> GetStatusesAsync(CancellationToken cancellationToken);

    /// <summary>One task with its entities (backed up or not), or null when CloudAlly no longer knows it.</summary>
    Task<CaTask?> GetTaskAsync(string accountId, string taskId, CancellationToken cancellationToken);

    /// <summary>One account of the partner, or null when it is no longer listed.</summary>
    Task<CaAccount?> FindAccountAsync(string accountId, CancellationToken cancellationToken);

    IAsyncEnumerable<CaBill> GetBillsAsync(CancellationToken cancellationToken);

    /// <summary>Runs the backup of a whole task now, or of one entity when <paramref name="entityId"/> is given.</summary>
    Task<CaResult> BackupNowAsync(string accountId, string taskId, string? entityId, CancellationToken cancellationToken);

    /// <summary>Stops the task's scheduled backups until it is activated again.</summary>
    Task<CaResult> PauseAsync(string accountId, string taskId, CancellationToken cancellationToken);

    /// <summary>Lets a paused task run on its schedule again, or adds one entity to the backup when <paramref name="entityId"/> is given.</summary>
    Task<CaResult> ActivateAsync(string accountId, string taskId, string? entityId, CancellationToken cancellationToken);

    /// <summary>Cancels the account's subscription and deletes the CloudAlly account (<c>DELETE v2/resellers/accounts/{id}</c>).</summary>
    Task<CaResult> CloseAccountAsync(string accountId, CancellationToken cancellationToken);

    Task<CaRestoreResult> RestoreAsync(string accountId, CaRecoveryRequest request, CancellationToken cancellationToken);

    Task ExportAsync(string accountId, CaRecoveryRequest request, CancellationToken cancellationToken);
}

internal sealed class CloudAllyClient(HttpClient http, IOptions<CloudAllyOptions> options) : ICloudAllyClient
{
    /// <summary>A guard against a list that never ends: far more pages than a partner of this size has.</summary>
    public const int MaxPages = 2_000;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private int PageSize => Math.Clamp(options.Value.PageSize, 1, 500);

    public IAsyncEnumerable<CaAccount> GetAccountsAsync(CancellationToken cancellationToken) =>
        PagesAsync<CaAccount>("v2/resellers/accounts", tokens: false, cancellationToken);

    public IAsyncEnumerable<CaTask> GetTasksAsync(CancellationToken cancellationToken) =>
        PagesAsync<CaTask>("v2/resellers/accounts/backup-tasks", tokens: false, cancellationToken);

    public IAsyncEnumerable<CaEntityStatus> GetStatusesAsync(CancellationToken cancellationToken) =>
        PagesAsync<CaEntityStatus>("v2/resellers/accounts/backup-statuses", tokens: true, cancellationToken);

    public IAsyncEnumerable<CaBill> GetBillsAsync(CancellationToken cancellationToken) =>
        PagesAsync<CaBill>("v2/resellers/bills", tokens: false, cancellationToken);

    public async Task<CaTask?> GetTaskAsync(string accountId, string taskId, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(TaskPath(accountId, taskId), cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        EnsureSuccess(response, "read the task");
        return await ReadAsync<CaTask>(response, cancellationToken);
    }

    public async Task<CaAccount?> FindAccountAsync(string accountId, CancellationToken cancellationToken)
    {
        await foreach (var account in GetAccountsAsync(cancellationToken))
        {
            if (string.Equals(account.Id, accountId, StringComparison.Ordinal))
            {
                return account;
            }
        }

        return null;
    }

    public Task<CaResult> BackupNowAsync(string accountId, string taskId, string? entityId, CancellationToken cancellationToken) =>
        PostAsync(entityId is null ? $"{TaskPath(accountId, taskId)}/backupNow" : $"{EntityPath(accountId, taskId, entityId)}/backupNow", "run the backup", cancellationToken);

    public Task<CaResult> PauseAsync(string accountId, string taskId, CancellationToken cancellationToken) =>
        PostAsync($"{TaskPath(accountId, taskId)}/pause", "pause the task", cancellationToken);

    public Task<CaResult> ActivateAsync(string accountId, string taskId, string? entityId, CancellationToken cancellationToken) =>
        PostAsync(entityId is null ? $"{TaskPath(accountId, taskId)}/activate" : $"{EntityPath(accountId, taskId, entityId)}/activate", "activate", cancellationToken);

    public async Task<CaResult> CloseAccountAsync(string accountId, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, $"v2/resellers/accounts/{Escape(accountId)}");
        // The reference lists the application's id and secret as required headers of this call, beside the token.
        CloudAllyTokenProvider.AddApplication(request.Headers, options.Value);
        using var response = await http.SendAsync(request, cancellationToken);
        EnsureSuccess(response, "close the account");
        return await ReadAsync<CaResult>(response, cancellationToken) ?? new CaResult(true, null, (int)response.StatusCode);
    }

    public async Task<CaRestoreResult> RestoreAsync(string accountId, CaRecoveryRequest request, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync($"v2/resellers/accounts/{Escape(accountId)}/recovery/restore", Body(request), Json, cancellationToken);
        EnsureSuccess(response, "start the restore");
        return await ReadAsync<CaRestoreResult>(response, cancellationToken) ?? new CaRestoreResult(false, null, null, null);
    }

    public async Task ExportAsync(string accountId, CaRecoveryRequest request, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync($"v2/resellers/accounts/{Escape(accountId)}/recovery/export", Body(request), Json, cancellationToken);
        EnsureSuccess(response, "start the export");
    }

    /// <summary>The body of a restore or an export with only the fields the CRM sets; CloudAlly keeps its defaults for the rest.</summary>
    internal static Dictionary<string, object?> Body(CaRecoveryRequest request)
    {
        var body = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["taskId"] = request.TaskId,
            ["account"] = request.Account,
            ["source"] = request.Source,
            ["date"] = request.Date,
            ["includeDeleted"] = request.IncludeDeleted,
        };
        if (!string.IsNullOrWhiteSpace(request.ExtId)) body["extid"] = request.ExtId;
        if (!string.IsNullOrWhiteSpace(request.TargetAccount)) body["targetAccount"] = request.TargetAccount;
        if (request.InPlace is { } inPlace) body["inPlace"] = inPlace;
        if (request.DownloadToPst is { } pst) body["downloadToPst"] = pst;
        return body;
    }

    private static string TaskPath(string accountId, string taskId) => $"v2/resellers/accounts/{Escape(accountId)}/backup-tasks/{Escape(taskId)}";

    private static string EntityPath(string accountId, string taskId, string entityId) => $"{TaskPath(accountId, taskId)}/entities/{Escape(entityId)}";

    private static string Escape(string value) => Uri.EscapeDataString(value);

    private async Task<CaResult> PostAsync(string path, string what, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsync(path, null, cancellationToken);
        EnsureSuccess(response, what);
        return await ReadAsync<CaResult>(response, cancellationToken) ?? new CaResult(true, null, (int)response.StatusCode);
    }

    /// <summary>
    /// Every page of a list. Pages are numbered from 1 and the list ends at the last page CloudAlly counts (<c>totalPages</c>), or
    /// at an empty page. The backup statuses also carry a page token: the first page goes without one (as CloudAlly's own client
    /// does, though the reference marks it required), each next page with the token of the one before. A token seen twice, or more
    /// than <see cref="MaxPages"/> pages, is a list that would never end, and the read fails as incomplete.
    /// </summary>
    private async IAsyncEnumerable<T> PagesAsync<T>(string path, bool tokens, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? token = null;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var page = 1; ; page++)
        {
            if (page > MaxPages)
            {
                throw new CloudAllyApiException(HttpStatusCode.OK, $"CloudAlly listed more than {MaxPages} pages of {path}; the read stops as incomplete.");
            }

            var query = string.Create(CultureInfo.InvariantCulture, $"{path}?page={page}&pageSize={PageSize}");
            if (tokens && token is not null)
            {
                query += "&nextPageToken=" + Uri.EscapeDataString(token);
            }

            using var response = await http.GetAsync(query, cancellationToken);
            EnsureSuccess(response, "read " + path);
            var result = await ReadAsync<CaPage<T>>(response, cancellationToken)
                         ?? throw new CloudAllyApiException(response.StatusCode, $"CloudAlly answered {path} without a page.");
            var items = result.Data ?? [];
            foreach (var item in items)
            {
                yield return item;
            }

            var next = string.IsNullOrEmpty(result.NextPageToken) ? null : result.NextPageToken;
            var last = items.Count == 0 || (result.TotalPages is { } total
                ? page >= total
                : tokens ? next is null : items.Count < PageSize);
            if (last)
            {
                yield break;
            }

            if (tokens && next is not null && !seen.Add(next))
            {
                throw new CloudAllyApiException(HttpStatusCode.OK, $"CloudAlly repeated a page token of {path}; the read stops as incomplete.");
            }

            token = next;
        }
    }

    private static async Task<T?> ReadAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.Content.Headers.ContentLength == 0)
        {
            return default;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        try
        {
            return await JsonSerializer.DeserializeAsync<T>(stream, Json, cancellationToken);
        }
        catch (JsonException) when (typeof(T) == typeof(CaResult) || typeof(T) == typeof(CaRestoreResult))
        {
            // An action answered with a body that is not the documented one: its status code already said it was taken.
            return default;
        }
    }

    /// <summary>The provider's words stay out of the message (they can name people); the status says what happened.</summary>
    private static void EnsureSuccess(HttpResponseMessage response, string what)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new CloudAllyApiException(response.StatusCode, $"CloudAlly could not {what} ({(int)response.StatusCode}).");
        }
    }
}
