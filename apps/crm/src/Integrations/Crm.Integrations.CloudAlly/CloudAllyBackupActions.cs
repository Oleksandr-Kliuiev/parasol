using System.Globalization;
using System.Text.Json;
using Crm.Authorization;
using Crm.Backup.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Actions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

/// <summary>
/// The actions people may ask of CloudAlly (M42), all on the one action path (M39.1) and all off until <c>EnabledActions</c> lists them.
/// A task is one service of one account; an entity is a mailbox, OneDrive or site in it, named with its task in the <c>task</c>
/// parameter; an account is the customer's CloudAlly account.
/// </summary>
public static class CloudAllyActionKinds
{
    public const string TaskTarget = "backup-task";
    public const string EntityTarget = "backup-entity";
    public const string AccountTarget = "backup-account";

    public const string Run = "backup.run";
    public const string Activate = "backup.activate";
    public const string Pause = "backup.pause";
    public const string Resume = "backup.resume";
    public const string Deactivate = "account.deactivate";
    public const string Export = "restore.export";
    public const string RestoreOther = "restore.other";
    public const string RestoreInPlace = "restore.in-place";

    /// <summary>The parameter that names an entity's task: CloudAlly addresses an entity through its task.</summary>
    public const string TaskParameter = "task";

    public static readonly string[] All = [Run, Activate, Pause, Resume, Deactivate, Export, RestoreOther, RestoreInPlace];
}

/// <summary>CloudAlly's own write switches (M42), read again for every preview, request and attempt.</summary>
internal sealed class CloudAllyActionGate(IOptionsMonitor<CloudAllyOptions> options) : IVendorActionGate
{
    public string System => CloudAllyTypes.System;

    public VendorActionSwitches Read()
    {
        var o = options.CurrentValue;
        return new VendorActionSwitches(o.Enabled, o.IsConfigured, o.WriteEnabled, o.DryRun, o.WriteAllowedCustomerIds, o.EnabledActions);
    }
}

/// <summary>
/// What every CloudAlly action shares: CloudAlly's system, the Drift rights, the allow-list by CloudAlly account (the target's
/// external customer id), and a read of CloudAlly before anything is sent. What a live read finds after the change is stored at
/// once, so the tab shows it without waiting for the next complete read.
/// </summary>
internal abstract class CloudAllyAction(IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, ILogger logger) : IVendorActionHandler
{
    public string System => CloudAllyTypes.System;

    public abstract string Kind { get; }

    public abstract string TargetType { get; }

    public abstract VendorActionLevel Level { get; }

    public string Permission => Permissions.ServiceWrite;

    public string ReadPermission => Permissions.ServiceRead;

    public virtual bool IsRepeatable => true;

    protected IBackupApi Backups => backups;

    protected ICloudAllyClient Client => client;

    public abstract Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken);

    public abstract Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken);

    protected async Task<string?> OrganizationNameAsync(Guid organizationId, CancellationToken ct) =>
        (await customers.GetOrganizationNamesAsync([organizationId], ct)).GetValueOrDefault(organizationId);

    /// <summary>A task's target: named by its account and CloudAlly's name of the service, as the action log lists it.</summary>
    protected async Task<VendorActionTarget> TargetAsync(BackupTaskRef task, CancellationToken ct) =>
        new(CloudAllyActionKinds.TaskTarget, task.ExternalId, $"{task.Account.Name} · {task.Alias ?? task.Source}", task.Account.OrganizationId,
            await OrganizationNameAsync(task.Account.OrganizationId, ct), task.Account.ExternalId, null);

    /// <summary>An entity's target: its name at CloudAlly (an address or a site), which a destructive restore asks to be typed.</summary>
    protected async Task<VendorActionTarget> TargetAsync(BackupEntityRef entity, CancellationToken ct) =>
        new(CloudAllyActionKinds.EntityTarget, entity.ExternalId, entity.Name, entity.Task.Account.OrganizationId,
            await OrganizationNameAsync(entity.Task.Account.OrganizationId, ct), entity.Task.Account.ExternalId, null);

    /// <summary>The saved entity an entity action names: its id is the target, its task the <c>task</c> parameter.</summary>
    protected async Task<BackupEntityRef?> EntityAsync(VendorActionRequest request, CancellationToken ct) =>
        Parameter(request.Parameters, CloudAllyActionKinds.TaskParameter) is { } task
            ? await backups.GetEntityAsync(System, task, request.TargetId, ct)
            : null;

    /// <summary>A text parameter, trimmed; null when it is missing, empty or not text.</summary>
    protected static string? Parameter(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            && value.GetString()?.Trim() is { Length: > 0 } text
            ? text
            : null;

    /// <summary>The task as CloudAlly has it now; a read that fails says so through the outcome, nothing is sent then.</summary>
    protected async Task<(CaTask? Task, VendorActionResult? Failure)> LiveTaskAsync(VendorActionContext context, string taskId, CancellationToken ct)
    {
        if (context.Action.ExternalCustomerId is not { } account)
        {
            return (null, VendorActionResult.Rejected("VND_BACKUP_GONE", "The action names no CloudAlly account; nothing was sent."));
        }

        try
        {
            return await client.GetTaskAsync(account, taskId, ct) is { } live
                ? (live, null)
                : (null, VendorActionResult.Rejected("VND_BACKUP_GONE", "CloudAlly no longer has this backup; nothing was sent."));
        }
        catch (Exception ex) when (IsReadFailure(ex, ct))
        {
            return (null, VendorActionResult.Later("VND_BACKUP_BUSY", "CloudAlly could not be read before sending; nothing was sent."));
        }
    }

    /// <summary>
    /// Sends the change; CloudAlly's refusal (a 4xx, or an answer that says it did not succeed) is an outcome, anything else — a
    /// timeout, a 5xx — is left to the runner as an unknown one.
    /// </summary>
    protected static async Task<VendorActionResult?> SendAsync(Func<Task<CaResult>> send)
    {
        try
        {
            var answer = await send();
            return answer.Success == false
                ? VendorActionResult.Failed("VND_BACKUP_REFUSED", "CloudAlly answered that it did not do it; nothing changed.")
                : null;
        }
        catch (CloudAllyApiException refused) when ((int)refused.Status is >= 400 and < 500 and not 408 and not 429)
        {
            return VendorActionResult.Failed("VND_BACKUP_REFUSED", $"CloudAlly refused it ({(int)refused.Status}); nothing changed.");
        }
    }

    /// <summary>Reads the task again after the change and stores what CloudAlly shows; a read that fails waits for the next complete read.</summary>
    protected async Task ConfirmAsync(VendorActionContext context, string taskId, CancellationToken ct)
    {
        try
        {
            if (context.Action.ExternalCustomerId is { } account && await client.GetTaskAsync(account, taskId, ct) is { } live)
            {
                await backups.ApplyTaskAsync(System, CloudAllyBackupMapping.Task(live, new Dictionary<(string, string), CaEntityStatus>()), ct);
            }
        }
        catch (Exception ex) when (IsReadFailure(ex, ct))
        {
            logger.LogWarning("CloudAlly task {TaskId} could not be read after the action ({ErrorType}); the next read shows it", taskId, ex.GetType().Name);
        }
    }

    public static bool IsReadFailure(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException or CloudAllyApiException or TimeoutException or Polly.Timeout.TimeoutRejectedException or JsonException ||
        (ex is TaskCanceledException && !ct.IsCancellationRequested);

    protected static VendorActionEffect Effect(string code, params (string Key, string? Value)[] values) =>
        new(code, values.ToDictionary(v => v.Key, v => v.Value));

    /// <summary>The words of an entity: the person's or site's name with the address, or the address alone.</summary>
    protected static string Who(BackupEntityRef entity) => entity.FullName is { Length: > 0 } full && full != entity.Name ? $"{full} ({entity.Name})" : entity.Name;
}

/// <summary>
/// "Take a backup now" (M42): of a whole task (<c>POST …/backup-tasks/{id}/backupNow</c>) or of one entity
/// (<c>…/entities/{entityId}/backupNow</c>). CloudAlly starts it when a backup machine is free. Safe to repeat: a backup already running
/// is not asked for twice.
/// </summary>
internal sealed class CloudAllyRunAction(IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, ILogger<CloudAllyRunAction> logger, bool entity)
    : CloudAllyAction(backups, customers, client, logger)
{
    public override string Kind => CloudAllyActionKinds.Run;

    public override string TargetType => entity ? CloudAllyActionKinds.EntityTarget : CloudAllyActionKinds.TaskTarget;

    public override VendorActionLevel Level => VendorActionLevel.Standard;

    public override async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (entity)
        {
            if (await EntityAsync(request, cancellationToken) is not { } one)
            {
                return VendorActionPlan.NotFound;
            }

            var target = await TargetAsync(one, cancellationToken);
            var parameters = VendorActionRules.Canonical(new Dictionary<string, object?> { [CloudAllyActionKinds.TaskParameter] = one.Task.ExternalId });
            return Blocked(one.Task.Status, one.Status) is { } block
                ? VendorActionPlan.Blocked(target, block.Code, block.Message)
                : new VendorActionPlan(target, [Effect("VND_EFFECT_BACKUP_RUN", ("name", Who(one)), ("service", one.Task.Service.ToString())),
                    Effect("VND_EFFECT_BACKUP_QUEUE")], null, parameters);
        }

        if (await Backups.GetTaskAsync(System, request.TargetId, cancellationToken) is not { } task)
        {
            return VendorActionPlan.NotFound;
        }

        var taskTarget = await TargetAsync(task, cancellationToken);
        return Blocked(task.Status, null) is { } taskBlock
            ? VendorActionPlan.Blocked(taskTarget, taskBlock.Code, taskBlock.Message)
            : new VendorActionPlan(taskTarget, [Effect("VND_EFFECT_BACKUP_RUN_ALL", ("service", task.Service.ToString()), ("account", task.Account.Name),
                ("count", task.Entities.ToString(CultureInfo.InvariantCulture))), Effect("VND_EFFECT_BACKUP_QUEUE")], null, "{}");
    }

    public override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var taskId = entity ? Parameter(context.Parameters, CloudAllyActionKinds.TaskParameter) : context.Action.TargetId;
        if (taskId is null)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "The action names no CloudAlly task; nothing was sent.");
        }

        var (live, failure) = await LiveTaskAsync(context, taskId, cancellationToken);
        if (live is null)
        {
            return failure!;
        }

        var liveEntity = entity ? live.Entities?.FirstOrDefault(e => e.Id == context.Action.TargetId) : null;
        if (entity && liveEntity is null)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "CloudAlly no longer has this user or site in the backup; nothing was sent.");
        }

        if (Blocked(live.Status, liveEntity?.Status) is { } block)
        {
            return VendorActionResult.Rejected(block.Code, block.Message + " Nothing was sent.");
        }

        if (CloudAllyBackupMapping.Running(liveEntity?.Progress ?? live.Progress))
        {
            return VendorActionResult.Skipped("VND_BACKUP_RUNNING", "A backup was already running at CloudAlly; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: CloudAlly was read, nothing was sent.");
        }

        var account = context.Action.ExternalCustomerId!;
        if (await SendAsync(() => Client.BackupNowAsync(account, taskId, liveEntity?.Id, cancellationToken)) is { } refused)
        {
            return refused;
        }

        await ConfirmAsync(context, taskId, cancellationToken);
        return VendorActionResult.Succeeded("VND_BACKUP_STARTED", "CloudAlly took the backup; it starts when a backup machine is free.");
    }

    private static VendorActionBlock? Blocked(string? taskStatus, string? entityStatus) =>
        IsPaused(taskStatus) || IsPaused(entityStatus)
            ? new("VND_BACKUP_PAUSED", "The backup is paused; resume it first.")
            : string.Equals(entityStatus, "NOTACTIVE", StringComparison.OrdinalIgnoreCase)
                ? new("VND_BACKUP_NOT_IN_BACKUP", "This user or site is not in the backup; add it first.")
                : null;

    internal static bool IsPaused(string? status) => string.Equals(status, "PAUSED", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Adds a user or site CloudAlly knows but does not back up to its task (<c>…/entities/{entityId}/activate</c>, M42: "include a new
/// user"). CloudAlly does not add new mailboxes by itself unless the task says so, and bills each one it backs up.
/// </summary>
internal sealed class CloudAllyActivateAction(IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, ILogger<CloudAllyActivateAction> logger)
    : CloudAllyAction(backups, customers, client, logger)
{
    public override string Kind => CloudAllyActionKinds.Activate;

    public override string TargetType => CloudAllyActionKinds.EntityTarget;

    public override VendorActionLevel Level => VendorActionLevel.Standard;

    public override async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (await EntityAsync(request, cancellationToken) is not { } entity)
        {
            return VendorActionPlan.NotFound;
        }

        var target = await TargetAsync(entity, cancellationToken);
        return !string.Equals(entity.Status, "NOTACTIVE", StringComparison.OrdinalIgnoreCase)
            ? VendorActionPlan.Blocked(target, "VND_BACKUP_ALREADY_ACTIVE", "This user or site is already in the backup.")
            : new VendorActionPlan(target,
                [Effect("VND_EFFECT_BACKUP_ACTIVATE", ("name", Who(entity)), ("service", entity.Task.Service.ToString())), Effect("VND_EFFECT_BACKUP_BILLED")],
                null, VendorActionRules.Canonical(new Dictionary<string, object?> { [CloudAllyActionKinds.TaskParameter] = entity.Task.ExternalId }));
    }

    public override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        if (Parameter(context.Parameters, CloudAllyActionKinds.TaskParameter) is not { } taskId)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "The action names no CloudAlly task; nothing was sent.");
        }

        var (live, failure) = await LiveTaskAsync(context, taskId, cancellationToken);
        if (live is null)
        {
            return failure!;
        }

        if (live.Entities?.FirstOrDefault(e => e.Id == context.Action.TargetId) is not { } entity)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "CloudAlly no longer knows this user or site; nothing was sent.");
        }

        if (!string.Equals(entity.Status, "NOTACTIVE", StringComparison.OrdinalIgnoreCase))
        {
            await ConfirmAsync(context, taskId, cancellationToken);
            return VendorActionResult.Skipped("VND_ALREADY_DONE", "The user or site was already in the backup; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: CloudAlly was read, nothing was sent.");
        }

        var account = context.Action.ExternalCustomerId!;
        if (await SendAsync(() => Client.ActivateAsync(account, taskId, entity.Id, cancellationToken)) is { } refused)
        {
            return refused;
        }

        await ConfirmAsync(context, taskId, cancellationToken);
        return VendorActionResult.Succeeded("VND_SENT", "CloudAlly added the user or site to the backup.");
    }
}

/// <summary>
/// Pauses a task's scheduled backups (<c>…/backup-tasks/{id}/pause</c>, M42): disruptive — nothing of the service is backed up until
/// someone resumes it — so it asks for a reason; the pause then shows as a coverage gap until then.
/// </summary>
internal sealed class CloudAllyPauseAction(IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, ILogger<CloudAllyPauseAction> logger, bool resume)
    : CloudAllyAction(backups, customers, client, logger)
{
    public override string Kind => resume ? CloudAllyActionKinds.Resume : CloudAllyActionKinds.Pause;

    public override string TargetType => CloudAllyActionKinds.TaskTarget;

    public override VendorActionLevel Level => resume ? VendorActionLevel.Standard : VendorActionLevel.Disruptive;

    public override async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (await Backups.GetTaskAsync(System, request.TargetId, cancellationToken) is not { } task)
        {
            return VendorActionPlan.NotFound;
        }

        var target = await TargetAsync(task, cancellationToken);
        var paused = CloudAllyRunAction.IsPaused(task.Status);
        if (paused != resume)
        {
            return resume
                ? VendorActionPlan.Blocked(target, "VND_BACKUP_NOT_PAUSED", "The backup is not paused.")
                : VendorActionPlan.Blocked(target, "VND_BACKUP_ALREADY_PAUSED", "The backup is already paused.");
        }

        var count = task.Entities.ToString(CultureInfo.InvariantCulture);
        return new VendorActionPlan(target, resume
            ? [Effect("VND_EFFECT_BACKUP_RESUME", ("service", task.Service.ToString()), ("account", task.Account.Name))]
            : [Effect("VND_EFFECT_BACKUP_PAUSE", ("service", task.Service.ToString()), ("account", task.Account.Name), ("count", count)),
                Effect("VND_EFFECT_BACKUP_PAUSE_GAP")], null, "{}");
    }

    public override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        var taskId = context.Action.TargetId;
        var (live, failure) = await LiveTaskAsync(context, taskId, cancellationToken);
        if (live is null)
        {
            return failure!;
        }

        if (CloudAllyRunAction.IsPaused(live.Status) != resume)
        {
            await ConfirmAsync(context, taskId, cancellationToken);
            return VendorActionResult.Skipped("VND_ALREADY_DONE", resume
                ? "The backup was not paused at CloudAlly; nothing was sent."
                : "The backup was already paused at CloudAlly; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: CloudAlly was read, nothing was sent.");
        }

        var account = context.Action.ExternalCustomerId!;
        if (await SendAsync(() => resume ? Client.ActivateAsync(account, taskId, null, cancellationToken) : Client.PauseAsync(account, taskId, cancellationToken)) is { } refused)
        {
            return refused;
        }

        await ConfirmAsync(context, taskId, cancellationToken);
        return VendorActionResult.Succeeded("VND_SENT", resume ? "CloudAlly resumed the backup." : "CloudAlly paused the backup.");
    }
}

/// <summary>
/// Closes the customer's CloudAlly account (<c>DELETE v2/resellers/accounts/{id}</c>, M42): CloudAlly cancels the subscription and
/// deletes the account with its backups. Destructive: a fresh sign-in, the account's name typed, a reason and a minute's hold. The
/// account is read first; one CloudAlly no longer lists, or lists as closed, is not asked twice.
/// </summary>
internal sealed class CloudAllyDeactivateAction(IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, ILogger<CloudAllyDeactivateAction> logger)
    : CloudAllyAction(backups, customers, client, logger)
{
    public override string Kind => CloudAllyActionKinds.Deactivate;

    public override string TargetType => CloudAllyActionKinds.AccountTarget;

    public override VendorActionLevel Level => VendorActionLevel.Destructive;

    public override async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (await Backups.GetAccountAsync(System, request.TargetId, cancellationToken) is not { } account)
        {
            return VendorActionPlan.NotFound;
        }

        var target = new VendorActionTarget(CloudAllyActionKinds.AccountTarget, account.ExternalId, account.Name, account.OrganizationId,
            await OrganizationNameAsync(account.OrganizationId, cancellationToken), account.ExternalId, null);
        return Closed(account.Status)
            ? VendorActionPlan.Blocked(target, "VND_ACCOUNT_CLOSED", "The CloudAlly account is already closed.")
            : new VendorActionPlan(target, [Effect("VND_EFFECT_ACCOUNT_DEACTIVATE", ("account", account.Name)), Effect("VND_EFFECT_ACCOUNT_DEACTIVATE_DATA")],
                null, "{}");
    }

    public override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        CaAccount? live;
        try
        {
            live = await Client.FindAccountAsync(context.Action.TargetId, cancellationToken);
        }
        catch (Exception ex) when (IsReadFailure(ex, cancellationToken))
        {
            return VendorActionResult.Later("VND_BACKUP_BUSY", "CloudAlly could not be read before sending; nothing was sent.");
        }

        if (live is null || Closed(live.Status))
        {
            return VendorActionResult.Skipped("VND_ALREADY_DONE", "CloudAlly no longer has the account open; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: CloudAlly was read, nothing was sent.");
        }

        return await SendAsync(() => Client.CloseAccountAsync(live.Id, cancellationToken))
               ?? VendorActionResult.Succeeded("VND_SENT", "CloudAlly closed the account.");
    }

    private static bool Closed(string? status) => status?.ToUpperInvariant() is "DELETED" or "UNSUBSCRIBED";
}
