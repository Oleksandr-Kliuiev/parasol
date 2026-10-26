using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Crm.Integrations.Core.Webhooks;

/// <summary>Why a delivery was refused. A refused delivery changes nothing but the time of the last refusal.</summary>
public enum WebhookRefusal
{
    /// <summary>No signature, or no key in the address: most likely not the vendor at all.</summary>
    Unsigned,

    /// <summary>Signed, but at a time too far from now: a recorded delivery sent again, or a clock far off.</summary>
    Stale,

    /// <summary>Signed with another secret, or a wrong key in the address: the vendor's secret was changed, or the delivery is forged.</summary>
    BadSignature,
}

/// <summary>
/// A job a delivery asks to run early, and, for a job that can read one record by its id (Atera's ticket conversations), the
/// record the delivery names.
/// </summary>
public sealed record EarlyRead(string Job, string? Target = null);

/// <param name="EventType">The vendor's name of the event as an identifier (<see cref="WebhookEvents.Name"/>), for the connections page.</param>
/// <param name="Reads">What to read early; none for an event Parasoll does not read.</param>
public sealed record WebhookReading(string EventType, IReadOnlyList<EarlyRead> Reads);

/// <summary>What a source made of a delivery: the event it proved, or why it refused it.</summary>
public sealed record WebhookCheck(WebhookReading? Reading, WebhookRefusal? Refusal)
{
    public static WebhookCheck Accepted(string eventType, params EarlyRead[] reads) => new(new WebhookReading(eventType, reads), null);

    public static WebhookCheck Refused(WebhookRefusal refusal) => new(null, refusal);
}

/// <summary>A delivery as it arrived: its headers, the key in its address (Atera's), and the body exactly as sent.</summary>
public sealed record WebhookDelivery(IHeaderDictionary Headers, string? Key, ReadOnlyMemory<byte> Body);

/// <summary>
/// A vendor whose webhooks Parasoll receives (M44). A webhook never carries data into the CRM: the source proves the delivery comes
/// from the vendor and names the jobs that read what changed; crm-worker then reads the vendor's API early, the way the schedule
/// would a few minutes later. Nothing a delivery says is stored but the name of its event.
/// </summary>
public interface IWebhookSource
{
    /// <summary>The system's name, as in <c>/webhooks/{system}</c>.</summary>
    string System { get; }

    /// <summary>Received at all: the integration and its webhook are switched on and a secret is set; otherwise the address answers 404.</summary>
    bool IsEnabled { get; }

    /// <summary>
    /// What keeps a webhook that is switched on from working (a missing or malformed secret), or null. crm-web refuses to start with one,
    /// so a switch that says "on" always means the address answers.
    /// </summary>
    string? ConfigurationProblem { get; }

    /// <summary>Proves the sender and reads the event, or says why the delivery is refused.</summary>
    WebhookCheck Check(WebhookDelivery delivery, DateTimeOffset now);
}

public static partial class WebhookEvents
{
    /// <summary>The largest body Parasoll reads: a vendor's event is a few kilobytes, and a larger one is refused before it is read.</summary>
    public const int MaxBodyBytes = 64 * 1024;

    /// <summary>
    /// An event type a vendor names, kept as a short identifier (letters, digits, <c>._:-</c>, at most 64), or <c>unknown</c>: the
    /// connections page shows it, so it never carries a sentence, an address or a name.
    /// </summary>
    public static string Name(string? type) =>
        type is { Length: > 0 and <= 64 } && Identifier().IsMatch(type) ? type.ToLowerInvariant() : "unknown";

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._:-]*\z")]
    private static partial Regex Identifier();
}
