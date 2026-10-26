using System.Text.Json;
using Crm.Integrations.Core.Webhooks;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress's webhooks (M44), signed through Svix. Of the eleven events Huntress sends (its <c>webhooks_doc.json</c>), those of incident
/// reports, escalations and platform actions start the alert read (<see cref="HuntressAlertSyncJob"/>): it reads every open record and
/// each stored one the lists no longer name, so a new report, a new comment, an overdue escalation and a closing all reach the CRM
/// through it. The two notifications (<c>platform_action.notification</c>, <c>account_notice.notification</c>) have nothing the API
/// can read and are only counted, as is the delivery "Send Test" makes. A body names a customer, a subject and a report's text: only
/// <c>event_type</c> is read from it, and only that name is kept.
/// </summary>
internal sealed class HuntressWebhookSource(IOptions<HuntressOptions> options) : IWebhookSource
{
    /// <summary>The events whose records the alert read reads, by the prefix of their name.</summary>
    private static readonly string[] AlertEvents = ["incident_report.", "escalation.", "platform_action."];

    public string System => HuntressTypes.System;

    private bool SwitchedOn => options.Value is { Enabled: true, WebhookEnabled: true };

    public bool IsEnabled => SwitchedOn && SvixSignature.Key(options.Value.WebhookSecret) is not null;

    public string? ConfigurationProblem => SwitchedOn && SvixSignature.Key(options.Value.WebhookSecret) is null
        ? "Integrations:Huntress:WebhookEnabled is on, but Integrations:Huntress:WebhookSecret is not the endpoint's signing secret (whsec_…)."
        : null;

    public WebhookCheck Check(WebhookDelivery delivery, DateTimeOffset now)
    {
        if (SvixSignature.Key(options.Value.WebhookSecret) is not { } key)
        {
            return WebhookCheck.Refused(WebhookRefusal.BadSignature);
        }

        if (SvixSignature.Verify(key, delivery.Headers, delivery.Body.Span, now) is { } refusal)
        {
            return WebhookCheck.Refused(refusal);
        }

        var type = WebhookEvents.Name(EventType(delivery.Body));
        return ReadsAlerts(type) ? WebhookCheck.Accepted(type, new EarlyRead(HuntressAlertSyncJob.JobId)) : WebhookCheck.Accepted(type);
    }

    internal static bool ReadsAlerts(string eventType) =>
        eventType != "platform_action.notification" && AlertEvents.Any(prefix => eventType.StartsWith(prefix, StringComparison.Ordinal));

    /// <summary>The event's name, or null for a body that is not a JSON object with a string <c>event_type</c>.</summary>
    private static string? EventType(ReadOnlyMemory<byte> body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            return document.RootElement.ValueKind == JsonValueKind.Object &&
                   document.RootElement.TryGetProperty("event_type", out var type) && type.ValueKind == JsonValueKind.String
                ? type.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
