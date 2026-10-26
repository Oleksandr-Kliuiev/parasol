using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Integrations.Core.Webhooks;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>
/// Atera's webhooks (M44): a ticket automation rule with the action "Trigger webhook" (Superpower and Enterprise plans) calls the
/// address with the key in it when a ticket is created, changes status or assignee, or is closed. Atera can neither sign a delivery
/// nor add a header, so the key in the address is the proof, compared in constant time. Every delivery starts the conversation read
/// (<see cref="AteraTicketConversationSyncJob"/>), which reads Atera's list of changed tickets; when the body names the ticket, that
/// ticket is read by its id as well. Atera does not document the body, so the ticket's id is looked for under the names its API
/// uses (<c>TicketID</c>, also inside a <c>Ticket</c> object, in any letter case, with or without <c>_</c>); nothing else of the body
/// is read. Atera sends no webhook for a new comment or an alert: those keep their schedules.
/// </summary>
internal sealed partial class AteraWebhookSource(IOptions<AteraOptions> options) : IWebhookSource
{
    public const int MinimumKeyLength = 32;

    public string System => AteraTypes.System;

    private bool SwitchedOn => options.Value is { Enabled: true, WebhookEnabled: true };

    public bool IsEnabled => SwitchedOn && IsKey(options.Value.WebhookKey);

    public string? ConfigurationProblem => SwitchedOn && !IsKey(options.Value.WebhookKey)
        ? $"Integrations:Atera:WebhookEnabled is on, but Integrations:Atera:WebhookKey is not at least {MinimumKeyLength} letters, digits, '-' or '_'."
        : null;

    public WebhookCheck Check(WebhookDelivery delivery, DateTimeOffset now)
    {
        if (delivery.Key is not { Length: > 0 } given)
        {
            return WebhookCheck.Refused(WebhookRefusal.Unsigned);
        }

        if (options.Value.WebhookKey is not { } key || !IsKey(key) ||
            !CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(given)), SHA256.HashData(Encoding.UTF8.GetBytes(key))))
        {
            return WebhookCheck.Refused(WebhookRefusal.BadSignature);
        }

        var (eventType, ticketId) = Read(delivery.Body);
        return WebhookCheck.Accepted(WebhookEvents.Name(eventType ?? "ticket"), new EarlyRead(AteraTicketConversationSyncJob.JobId, ticketId));
    }

    private static bool IsKey(string? key) => key is not null && KeyPattern().IsMatch(key);

    /// <summary>The name of the event and the ticket's id, each when the body carries one Parasoll recognizes.</summary>
    internal static (string? EventType, string? TicketId) Read(ReadOnlyMemory<byte> body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return (null, null);
            }

            string? eventType = null, ticketId = null;
            foreach (var property in document.RootElement.EnumerateObject())
            {
                var name = Normalized(property.Name);
                if (name is "eventtype" or "event" or "trigger" && property.Value.ValueKind == JsonValueKind.String)
                {
                    eventType ??= property.Value.GetString();
                }
                else if (name == "ticketid")
                {
                    ticketId ??= TicketId(property.Value);
                }
                else if (name == "ticket" && property.Value.ValueKind == JsonValueKind.Object)
                {
                    ticketId ??= property.Value.EnumerateObject()
                        .Where(p => Normalized(p.Name) is "ticketid" or "id")
                        .Select(p => TicketId(p.Value)).FirstOrDefault(id => id is not null);
                }
            }

            return (eventType, ticketId);
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }

    private static string Normalized(string name) => name.Replace("_", string.Empty, StringComparison.Ordinal).ToLowerInvariant();

    /// <summary>A ticket's id as Atera numbers them: a positive whole number, sent as a number or as its digits.</summary>
    private static string? TicketId(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Number when value.TryGetInt64(out var id) && id > 0 => id.ToString(CultureInfo.InvariantCulture),
        JsonValueKind.String when long.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var id) && id > 0 =>
            id.ToString(CultureInfo.InvariantCulture),
        _ => null,
    };

    [GeneratedRegex(@"^[A-Za-z0-9_-]{32,256}\z")]
    private static partial Regex KeyPattern();
}
