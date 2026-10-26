using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Crm.Integrations.CloudAlly;

/// <summary>
/// The answers of CloudAlly's partner API v2 (<c>/v2/resellers/…</c>, M42), with the names of its reference (api.cloudally.com,
/// "Management v2"). Fields whose format the reference leaves open — dates as text, as <c>yyyyMMddHHmmss</c> numbers or as times —
/// are kept as JSON and read by <see cref="CloudAllyDates"/>.
/// </summary>
public sealed record CaPage<T>(
    [property: JsonPropertyName("page")] int? Page,
    [property: JsonPropertyName("totalPages")] int? TotalPages,
    [property: JsonPropertyName("total")] int? Total,
    [property: JsonPropertyName("nextPageToken")] string? NextPageToken,
    [property: JsonPropertyName("data")] List<T>? Data);

/// <summary>A customer account of the partner (<c>UserView</c>): CloudAlly calls the customer a user.</summary>
public sealed record CaAccount(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("region")] string? Region,
    [property: JsonPropertyName("partnerID")] string? PartnerId,
    [property: JsonPropertyName("externalId")] string? ExternalId,
    [property: JsonPropertyName("currency")] string? Currency);

/// <summary>Where a backup task stands now (<c>TaskProgressView</c>); present while it runs.</summary>
public sealed record CaProgress(
    [property: JsonPropertyName("current")] int? Current,
    [property: JsonPropertyName("state")] string? State,
    [property: JsonPropertyName("service")] string? Service,
    [property: JsonPropertyName("cancelled")] bool? Cancelled);

/// <summary>
/// A backup task (<c>PartnerTaskView</c>, <c>TaskViewWithEntities</c>): one service of one account, e.g. the account's Exchange
/// mailboxes. <see cref="UserId"/> is the account's id; <see cref="Entities"/> come only with the single task's read.
/// </summary>
public sealed record CaTask(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("account")] string? Account,
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("source")] string? Source,
    [property: JsonPropertyName("userId")] string? UserId,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("region")] string? Region,
    [property: JsonPropertyName("alias")] string? Alias,
    [property: JsonPropertyName("snapshotDate")] JsonElement? SnapshotDate,
    [property: JsonPropertyName("lastBackupDates")] Dictionary<string, JsonElement>? LastBackupDates,
    [property: JsonPropertyName("nextBackup")] JsonElement? NextBackup,
    [property: JsonPropertyName("progress")] CaProgress? Progress,
    [property: JsonPropertyName("size")] long? Size,
    [property: JsonPropertyName("createDate")] JsonElement? CreateDate,
    [property: JsonPropertyName("numOfBilledEntities")] int? BilledEntities,
    [property: JsonPropertyName("numOfEntities")] int? EntityCount,
    [property: JsonPropertyName("userEmail")] string? UserEmail,
    [property: JsonPropertyName("multiEntitiesTask")] bool? MultiEntities,
    [property: JsonPropertyName("entities")] List<CaEntity>? Entities)
{
    public bool IsBackup => string.Equals(Type, "BACKUP", StringComparison.OrdinalIgnoreCase);
}

/// <summary>A mailbox, OneDrive, site or team inside a task (<c>EntityView</c>); <see cref="Status"/> NOTACTIVE means not backed up.</summary>
public sealed record CaEntity(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("userId")] string? UserId,
    [property: JsonPropertyName("taskId")] string? TaskId,
    [property: JsonPropertyName("entity")] string? Entity,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("lastBackupDates")] Dictionary<string, JsonElement>? LastBackupDates,
    [property: JsonPropertyName("fullName")] string? FullName,
    [property: JsonPropertyName("progress")] CaProgress? Progress,
    [property: JsonPropertyName("extId")] string? ExtId);

/// <summary>
/// The backup status of one backed-up entity (<c>V2EntityStatusDirectView</c>). The reference: a last attempt later than the last
/// successful backup is the signal that the backup failed.
/// </summary>
public sealed record CaEntityStatus(
    [property: JsonPropertyName("userId")] string? UserId,
    [property: JsonPropertyName("taskId")] string? TaskId,
    [property: JsonPropertyName("source")] string? Source,
    [property: JsonPropertyName("entityName")] string? EntityName,
    [property: JsonPropertyName("lastBackupDate")] JsonElement? LastBackupDate,
    [property: JsonPropertyName("lastBackupAttemptDate")] JsonElement? LastBackupAttemptDate,
    [property: JsonPropertyName("size")] long? Size,
    [property: JsonPropertyName("backupStatus")] List<CaSubStatus>? BackupStatus,
    [property: JsonPropertyName("msLicensing")] string? MsLicensing);

/// <summary>One part of an entity's backup (mail, calendar, …) with its short error and CloudAlly's help page for it.</summary>
public sealed record CaSubStatus(
    [property: JsonPropertyName("subSource")] string? SubSource,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("errFAQLink")] string? ErrorLink);

/// <summary>What CloudAlly bills for one account (<c>BillingDetailsView</c>): the current lines, one per service.</summary>
public sealed record CaBill(
    [property: JsonPropertyName("userId")] string? UserId,
    [property: JsonPropertyName("currency")] string? Currency,
    [property: JsonPropertyName("paymentType")] string? PaymentType,
    [property: JsonPropertyName("nextPaymentDate")] JsonElement? NextPaymentDate,
    [property: JsonPropertyName("subscribed")] bool? Subscribed,
    [property: JsonPropertyName("total")] decimal? Total,
    [property: JsonPropertyName("lines")] List<CaBillLine>? Lines);

public sealed record CaBillLine(
    [property: JsonPropertyName("price")] decimal? Price,
    [property: JsonPropertyName("accounts")] int? Accounts,
    [property: JsonPropertyName("seat")] int? Seats,
    [property: JsonPropertyName("service")] string? Service,
    [property: JsonPropertyName("type")] string? Type,
    [property: JsonPropertyName("source")] string? Source,
    [property: JsonPropertyName("storage")] long? Storage,
    [property: JsonPropertyName("total")] decimal? Total);

/// <summary>The answer of an action (<c>JsonResponseDTO</c>).</summary>
public sealed record CaResult(
    [property: JsonPropertyName("success")] bool? Success,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("statusCode")] int? StatusCode);

/// <summary>
/// The answer of a restore (<c>RestoreOrDownloadResultDTO</c>). <see cref="NeedRedirect"/> means CloudAlly wants a person to sign in
/// to the customer's tenant in a browser first: the CRM never follows that address.
/// </summary>
public sealed record CaRestoreResult(
    [property: JsonPropertyName("needRedirect")] bool? NeedRedirect,
    [property: JsonPropertyName("redirectUrl")] string? RedirectUrl,
    [property: JsonPropertyName("showNotification")] bool? ShowNotification,
    [property: JsonPropertyName("notificationMessage")] string? NotificationMessage);

/// <summary>What a restore or an export asks for (<c>RestoreDTO</c>, <c>ExportDTO</c>): only the fields the CRM sets.</summary>
public sealed record CaRecoveryRequest(
    string TaskId,
    string Account,
    string Source,
    long Date,
    bool IncludeDeleted,
    string? ExtId,
    string? TargetAccount = null,
    bool? InPlace = null,
    bool? DownloadToPst = null);

/// <summary>Reads CloudAlly's dates, whose reference leaves the format open (M42).</summary>
public static class CloudAllyDates
{
    private static readonly string[] CompactFormats = ["yyyyMMddHHmmss", "yyyyMMddHHmm", "yyyyMMdd"];

    /// <summary>
    /// A date as CloudAlly sends it: <c>yyyyMMddHHmmss</c> as a number or text (UTC, as the reference names no zone), an ISO 8601
    /// time, or a Unix time in milliseconds or seconds. Null for anything else, a zero or an empty value.
    /// </summary>
    public static DateTimeOffset? Parse(JsonElement? value) => value switch
    {
        { ValueKind: JsonValueKind.Number } number when number.TryGetInt64(out var n) => FromNumber(n),
        { ValueKind: JsonValueKind.String } text => Parse(text.GetString()),
        _ => null,
    };

    public static DateTimeOffset? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var trimmed = text.Trim();
        if (trimmed.All(char.IsAsciiDigit))
        {
            return long.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? FromNumber(n) : null;
        }

        return DateTimeOffset.TryParse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var time)
            ? time
            : null;
    }

    /// <summary>The newest of a table of dates per part (mail, calendar, …), as tasks and entities report their last backups.</summary>
    public static DateTimeOffset? Newest(IReadOnlyDictionary<string, JsonElement>? dates) =>
        dates?.Values.Select(v => Parse(v)).Where(d => d is not null).Max();

    /// <summary>A day as CloudAlly takes it in a restore or an export: the end of that day in UTC, <c>yyyyMMddHHmmss</c>.</summary>
    public static long Compact(DateOnly day) =>
        long.Parse(day.ToString("yyyyMMdd", CultureInfo.InvariantCulture) + "235959", NumberStyles.None, CultureInfo.InvariantCulture);

    private static DateTimeOffset? FromNumber(long n)
    {
        if (n <= 0)
        {
            return null;
        }

        var digits = n.ToString(CultureInfo.InvariantCulture);
        // 20261022143000 has 14 digits: CloudAlly's compact form, before the Unix readings it would otherwise be mistaken for.
        if (digits.Length is 8 or 12 or 14 && digits.StartsWith('2') &&
            DateTime.TryParseExact(digits, CompactFormats, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var compact))
        {
            return new DateTimeOffset(DateTime.SpecifyKind(compact, DateTimeKind.Utc));
        }

        return n switch
        {
            >= 100_000_000_000 and <= 253_402_300_799_000 => DateTimeOffset.FromUnixTimeMilliseconds(n),
            >= 1_000_000_000 and <= 253_402_300_799 => DateTimeOffset.FromUnixTimeSeconds(n),
            _ => null,
        };
    }
}
