using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Security.Contracts;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress in the CRM's list of integrations (M41): its organizations are external records a person links to CRM organizations on
/// the mapping screen. Huntress keeps no organization number, so nothing links by itself: the screen suggests names, a person
/// decides. Creating an organization in Huntress comes with M43.
/// </summary>
internal sealed class HuntressAdapter(IOptions<HuntressOptions> options, IServiceProvider services) : IIntegrationAdapter
{
    public string System => HuntressTypes.System;

    // Switched on for the CRM; calls to Huntress run in crm-worker, the only host with the key.
    public bool IsEnabled => options.Value.Enabled;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } =
    [
        new(HuntressTypes.System, HuntressTypes.Organization, EntityTypes.Organization),
    ];

    public string? CreateOrganizationOperation => null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record) =>
        record.ExternalType == HuntressTypes.Organization && ExternalRecordStore.Read<HuntressOrganization>(record) is { } o
            ? new ExternalOrganizationData(o.Name, null, null, null, null, [], null, null, null)
            : null;

    public ExternalContactData? ToContactData(ExternalRecord record) => null;

    public async Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            return new ConnectionTestResult(false, "The Huntress API key and secret are not configured on this instance.");
        }

        try
        {
            var account = await services.GetRequiredService<IHuntressClient>().GetAccountAsync(cancellationToken);
            return new ConnectionTestResult(true, $"Connected to Huntress (account {account.Id.ToString(CultureInfo.InvariantCulture)}).");
        }
        catch (Exception ex) when (ex is HttpRequestException or HuntressApiException)
        {
            return new ConnectionTestResult(false, ex.Message);
        }
    }
}

/// <summary>Links from Huntress organization ids to CRM organizations, loaded once per run.</summary>
public sealed class HuntressLinkIndex(IntegrationDbContext db)
{
    public async Task<IReadOnlyDictionary<long, Guid>> OrganizationsAsync(CancellationToken ct)
    {
        var links = await db.ExternalLinks.AsNoTracking()
            .Where(l => l.System == HuntressTypes.System && l.ExternalType == HuntressTypes.Organization)
            .Select(l => new { l.ExternalId, l.EntityId })
            .ToListAsync(ct);
        var result = new Dictionary<long, Guid>();
        foreach (var link in links)
        {
            if (long.TryParse(link.ExternalId, NumberStyles.None, CultureInfo.InvariantCulture, out var id))
            {
                result[id] = link.EntityId;
            }
        }

        return result;
    }
}

/// <summary>
/// Huntress's organizations (M41): every one as an external record for the mapping screen (unchanged payloads skipped by hash), and
/// for the linked ones what Huntress counts now — agents it bills and those it calls unresponsive, outdated or isolated, identities,
/// learners — into the security module.
/// </summary>
public sealed class HuntressOrganizationSyncJob(
    IHuntressClient client,
    ExternalRecordStore records,
    HuntressLinkIndex links,
    ISecurityApi security,
    SyncRunner runner,
    TimeProvider time,
    IOptions<HuntressOptions> options,
    ILogger<HuntressOrganizationSyncJob> logger)
{
    public const string JobId = "huntress-organizations";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Huntress organization sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(HuntressTypes.System, JobId, async (progress, ct) =>
        {
            var started = time.GetUtcNow();
            var organizations = new List<HuntressOrganization>();
            await foreach (var organization in client.GetOrganizationsAsync(ct))
            {
                progress.Read++;
                organizations.Add(organization);
                if ((await records.UpsertAsync(HuntressMapping.ToRecord(organization), ct)).Changed)
                {
                    progress.Changed++;
                }
            }

            var gone = await records.MarkUnseenAsGoneAsync(HuntressTypes.System, HuntressTypes.Organization, started, ct);
            var linked = await links.OrganizationsAsync(ct);
            var usages = new List<ExternalUsage>();
            var unknown = 0;
            foreach (var organization in organizations.Where(o => linked.ContainsKey(o.Id)))
            {
                // A usage that cannot be read fails the run: a figure left out would read as zero agents.
                if (await client.GetUsageAsync(organization.Id, ct) is not { } usage)
                {
                    unknown++;
                    continue;
                }

                usages.Add(new ExternalUsage(
                    HuntressTypes.System, organization.Id, linked[organization.Id], organization.Name, organization.AgentsCount, usage.BillableAgents,
                    usage.UnresponsiveAgents, usage.OutdatedAgents, usage.IsolatedAgents, usage.BillableIdentities, usage.SatLearners, usage.BillableLogSources));
            }

            var stored = await security.ApplyUsageAsync(usages, ct);
            progress.Message = $"organizations {organizations.Count}, changed {progress.Changed}, no longer in Huntress {gone}; " +
                               $"usage of {usages.Count} linked: changed {stored.Changed}, unknown to Huntress {unknown}";
        }, cancellationToken);
    }
}

/// <summary>Maps Huntress's records to the CRM's vocabulary; the client reads the fields, here only the meaning is mapped.</summary>
internal static partial class HuntressMapping
{
    /// <summary>A computer is online when it called Huntress back within this time; Huntress's API has no online flag of its own.</summary>
    public static readonly TimeSpan OnlineWithin = TimeSpan.FromMinutes(60);

    public static ExternalRecordInput ToRecord(HuntressOrganization o) => new(
        HuntressTypes.System, HuntressTypes.Organization, o.Id.ToString(CultureInfo.InvariantCulture), o.Name, o, o.UpdatedAt);

    public static Crm.Service.Contracts.DeviceType DeviceTypeOf(HuntressAgent agent)
    {
        var text = $"{agent.Os} {string.Join(' ', agent.Tags)}".ToLowerInvariant();
        if (text.Contains("server", StringComparison.Ordinal) || text.Contains("domain controller", StringComparison.Ordinal))
        {
            return Crm.Service.Contracts.DeviceType.Server;
        }

        return agent.Platform is "windows" or "darwin" ? Crm.Service.Contracts.DeviceType.Workstation : Crm.Service.Contracts.DeviceType.Other;
    }

    /// <summary>
    /// An agent as a device of the mirror (M41): Huntress's keys of the computer (serial number, MAC addresses, host name) so the
    /// machine matcher can join it with the computer's Atera agent, the organization it reports under (the device's second id, which
    /// its actions are allowed for), what Huntress says about the system and the network, its agent version, and its view of Defender
    /// and isolation. The link comes from configuration only.
    /// </summary>
    public static Crm.Service.Contracts.ExternalDevice Device(HuntressAgent a, string? urlTemplate, DateTimeOffset now) => new(
        a.Id.ToString(CultureInfo.InvariantCulture),
        a.Hostname,
        DeviceTypeOf(a),
        a.Os,
        a.LastCallbackAt is { } seen && now - seen <= OnlineWithin,
        a.LastCallbackAt,
        Url(urlTemplate, a.Id),
        a.SerialNumber,
        a.MacAddresses,
        a.OrganizationId.ToString(CultureInfo.InvariantCulture),
        new Crm.Service.Contracts.DeviceInventoryReading(
            null, null, null, null, null, null, null, null, null, a.OsBuildVersion, a.Ipv4Addresses, a.ExternalIp, a.DomainName, null, null, null, [],
            a.Version),
        Platform: a.Platform,
        Protection: new Crm.Service.Contracts.DeviceProtectionReading(a.DefenderStatus, a.DefenderSubstatus, a.DefenderPolicyStatus, a.LastSurveyAt, a.FirewallStatus));

    /// <summary>Huntress's severities in the CRM's two: critical and high are critical, low is a warning.</summary>
    public static Crm.Service.Contracts.AlertSeverity Severity(string severity) =>
        severity is "critical" or "high" ? Crm.Service.Contracts.AlertSeverity.Critical : Crm.Service.Contracts.AlertSeverity.Warning;

    public static string? Url(string? template, long id) =>
        string.IsNullOrWhiteSpace(template) ? null : string.Format(CultureInfo.InvariantCulture, template, id);

    /// <summary>The alert ids of Huntress's records in the CRM, one space of ids per kind: <c>incident:7001</c>.</summary>
    public static string IncidentAlertId(long id) => "incident:" + id.ToString(CultureInfo.InvariantCulture);

    public static string NoticeAlertId(NoticeKind kind, long id) =>
        (kind == NoticeKind.Escalation ? "escalation:" : "platform-action:") + id.ToString(CultureInfo.InvariantCulture);

    /// <summary>The record an alert id names: its kind and Huntress's id; null for an id that is no Huntress record's.</summary>
    public static (string Kind, long Id)? ReadAlertId(string? alertId)
    {
        var parts = alertId?.Split(':');
        return parts is [var kind and ("incident" or "escalation" or "platform-action"), var number] &&
               long.TryParse(number, NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0
            ? (kind, id)
            : null;
    }

    public static NoticeKind Kind(HuntressNoticeKind kind) => kind == HuntressNoticeKind.Escalation ? NoticeKind.Escalation : NoticeKind.PlatformAction;
}
