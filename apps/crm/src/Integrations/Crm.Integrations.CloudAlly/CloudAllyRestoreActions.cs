using System.Globalization;
using System.Text.Json;
using Crm.Backup.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Actions;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.CloudAlly;

/// <summary>Where a restore puts what it brings back (M42).</summary>
public enum CloudAllyRestoreWay
{
    /// <summary>A download (PST for mail, ZIP for files): CloudAlly e-mails the link; nothing changes in the tenant.</summary>
    Export,

    /// <summary>Into another account of the same domain (mail, OneDrive), or into a new site (SharePoint).</summary>
    Other,

    /// <summary>Back where it came from, beside the data people work with now.</summary>
    InPlace,
}

/// <summary>
/// The restore wizard's actions (M42): a mailbox, a OneDrive or a site as it was on a day — exported, restored into another account
/// (or a new site), or restored in place. CloudAlly's API restores whole entities only (it lists no items), so a single e-mail is
/// restored in CloudAlly. An export or a restore elsewhere hands one person's data to someone else, so it asks for a reason; a
/// restore in place writes into live data, so it is destructive. A second restore would bring everything back twice: an attempt
/// without a clear answer is never repeated, a person checks CloudAlly instead.
/// </summary>
internal sealed class CloudAllyRestoreAction(
    IBackupApi backups, ICustomersApi customers, ICloudAllyClient client, TimeProvider time, ILogger<CloudAllyRestoreAction> logger, CloudAllyRestoreWay way)
    : CloudAllyAction(backups, customers, client, logger)
{
    public const string DateParameter = "date";
    public const string TargetParameter = "target";
    public const string DeletedParameter = "includeDeleted";

    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public override string Kind => way switch
    {
        CloudAllyRestoreWay.Export => CloudAllyActionKinds.Export,
        CloudAllyRestoreWay.Other => CloudAllyActionKinds.RestoreOther,
        _ => CloudAllyActionKinds.RestoreInPlace,
    };

    public override string TargetType => CloudAllyActionKinds.EntityTarget;

    public override VendorActionLevel Level => way == CloudAllyRestoreWay.InPlace ? VendorActionLevel.Destructive : VendorActionLevel.Disruptive;

    public override bool IsRepeatable => false;

    public override async Task<VendorActionPlan> PlanAsync(VendorActionRequest request, CancellationToken cancellationToken)
    {
        if (await EntityAsync(request, cancellationToken) is not { } entity)
        {
            return VendorActionPlan.NotFound;
        }

        var target = await TargetAsync(entity, cancellationToken);
        var service = entity.Task.Service;
        if (service is not (BackupService.Mail or BackupService.OneDrive or BackupService.SharePoint))
        {
            return VendorActionPlan.Blocked(target, "VND_RESTORE_SERVICE", "Parasoll restores mailboxes, OneDrive and SharePoint sites; restore this in CloudAlly.");
        }

        if (string.Equals(entity.Status, "NOTACTIVE", StringComparison.OrdinalIgnoreCase) || entity.LastBackupAt is null)
        {
            return VendorActionPlan.Blocked(target, "VND_RESTORE_NO_BACKUP", "There is no backup of this user or site to restore from.");
        }

        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
        if (Day(request.Parameters) is not { } day || day > today || day < new DateOnly(2000, 1, 1))
        {
            return VendorActionPlan.Blocked(target, "VND_RESTORE_DATE", "Choose a day from the past, today at the latest.");
        }

        string? to = null;
        if (way == CloudAllyRestoreWay.Other && service != BackupService.SharePoint)
        {
            to = Parameter(request.Parameters, TargetParameter)?.ToLowerInvariant();
            if (to is null || CloudAllyMapping.DomainOf(to) is not { } domain || to.Count(c => c == '@') != 1 || to.Length > 256)
            {
                return VendorActionPlan.Blocked(target, "VND_RESTORE_TARGET", "Give the address of the account to restore into.");
            }

            if (string.Equals(to, entity.Name, StringComparison.OrdinalIgnoreCase))
            {
                return VendorActionPlan.Blocked(target, "VND_RESTORE_TARGET_SAME", "That is the same account: restore it in place instead.");
            }

            if (!string.Equals(domain, CloudAllyMapping.DomainOf(entity.Name), StringComparison.OrdinalIgnoreCase))
            {
                return VendorActionPlan.Blocked(target, "VND_RESTORE_TARGET_DOMAIN", "CloudAlly restores into an account of the same domain only.");
            }
        }

        var deleted = Flag(request.Parameters, DeletedParameter);
        var values = new Dictionary<string, object?>
        {
            [CloudAllyActionKinds.TaskParameter] = entity.Task.ExternalId,
            [DateParameter] = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            [DeletedParameter] = deleted,
        };
        if (to is not null)
        {
            values[TargetParameter] = to;
        }

        var date = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var who = Who(entity);
        var effects = new List<VendorActionEffect>
        {
            way switch
            {
                CloudAllyRestoreWay.Export => Effect("VND_EFFECT_RESTORE_EXPORT", ("name", who), ("service", service.ToString()), ("date", date),
                    ("format", service == BackupService.Mail ? "PST" : "ZIP")),
                CloudAllyRestoreWay.Other when service == BackupService.SharePoint => Effect("VND_EFFECT_RESTORE_NEW_SITE", ("name", who), ("date", date)),
                CloudAllyRestoreWay.Other => Effect("VND_EFFECT_RESTORE_OTHER", ("name", who), ("service", service.ToString()), ("date", date), ("target", to)),
                _ => Effect("VND_EFFECT_RESTORE_IN_PLACE", ("name", who), ("service", service.ToString()), ("date", date)),
            },
        };
        if (deleted)
        {
            effects.Add(Effect("VND_EFFECT_RESTORE_DELETED"));
        }

        effects.Add(Effect(way == CloudAllyRestoreWay.Export ? "VND_EFFECT_RESTORE_LINK" : "VND_EFFECT_RESTORE_JOB"));
        return new VendorActionPlan(target, effects, null, VendorActionRules.Canonical(values));
    }

    public override async Task<VendorActionResult> ExecuteAsync(VendorActionContext context, CancellationToken cancellationToken)
    {
        if (Parameter(context.Parameters, CloudAllyActionKinds.TaskParameter) is not { } taskId || Day(context.Parameters) is not { } day)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "The action's parameters are no longer there; nothing was sent.");
        }

        var (live, failure) = await LiveTaskAsync(context, taskId, cancellationToken);
        if (live is null)
        {
            return failure!;
        }

        if (live.Entities?.FirstOrDefault(e => e.Id == context.Action.TargetId) is not { } entity)
        {
            return VendorActionResult.Rejected("VND_BACKUP_GONE", "CloudAlly no longer has this user or site in the backup; nothing was sent.");
        }

        if (context.Simulate)
        {
            return VendorActionResult.Simulated("VND_DRY_RUN", "Test mode: CloudAlly was read, nothing was sent.");
        }

        var service = CloudAllyMapping.ServiceOf(live.Source);
        var request = new CaRecoveryRequest(
            live.Id, string.IsNullOrWhiteSpace(entity.Entity) ? entity.Id : entity.Entity.Trim(), live.Source ?? string.Empty, CloudAllyDates.Compact(day),
            Flag(context.Parameters, DeletedParameter), entity.ExtId,
            TargetAccount: way == CloudAllyRestoreWay.Other && service != BackupService.SharePoint ? Parameter(context.Parameters, TargetParameter) : null,
            InPlace: (service is BackupService.OneDrive or BackupService.SharePoint) && way != CloudAllyRestoreWay.Export ? way == CloudAllyRestoreWay.InPlace : null,
            DownloadToPst: way == CloudAllyRestoreWay.Export ? service == BackupService.Mail : null);
        var account = context.Action.ExternalCustomerId!;
        try
        {
            if (way == CloudAllyRestoreWay.Export)
            {
                await Client.ExportAsync(account, request, cancellationToken);
                return VendorActionResult.Succeeded("VND_EXPORT_STARTED", "CloudAlly took the export; it e-mails the download link when the file is ready.");
            }

            var answer = await Client.RestoreAsync(account, request, cancellationToken);
            // CloudAlly asks for a person's sign-in to the customer's tenant first: whether anything started is not clear, so a person checks.
            return answer.NeedRedirect == true
                ? VendorActionResult.Uncertain("VND_RESTORE_SIGN_IN", "CloudAlly wants a sign-in to the customer's Microsoft 365 before it restores. Check in CloudAlly.")
                : VendorActionResult.Succeeded("VND_RESTORE_STARTED", "CloudAlly took the restore; it runs as a job at CloudAlly.");
        }
        catch (CloudAllyApiException refused) when ((int)refused.Status is >= 400 and < 500 and not 408 and not 429)
        {
            return VendorActionResult.Failed("VND_BACKUP_REFUSED", $"CloudAlly refused it ({(int)refused.Status}); nothing changed.");
        }
    }

    private static DateOnly? Day(JsonElement parameters) =>
        Parameter(parameters, DateParameter) is { } text && DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day)
            ? day
            : null;

    private static bool Flag(JsonElement parameters, string name) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
}
