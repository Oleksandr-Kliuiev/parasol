using System.Text;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Webhooks;
using Crm.Integrations.Huntress;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>M44: a webhook proves its sender before it asks for anything, and asks only for a read.</summary>
public sealed class WebhookTests
{
    private static readonly DateTimeOffset Sent = DateTimeOffset.FromUnixTimeSeconds(1731705121);

    private static HeaderDictionary Svix(string id, long timestamp, string signature, string prefix = "svix") => new()
    {
        [$"{prefix}-id"] = id,
        [$"{prefix}-timestamp"] = timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture),
        [$"{prefix}-signature"] = signature,
    };

    [Theory]
    // The two examples Svix publishes for checking a signature without its library.
    [InlineData("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330L, "{\"test\": 2432232314}",
        "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")]
    [InlineData("whsec_plJ3nmyCDGBKInavdOK15jsl", "msg_loFOjxBNrRLzqYUf", 1731705121L, "{\"event_type\":\"ping\",\"data\":{\"success\":true}}",
        "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=")]
    public void Svix_published_examples_verify(string secret, string id, long timestamp, string body, string signature)
    {
        var key = SvixSignature.Key(secret)!;
        var at = DateTimeOffset.FromUnixTimeSeconds(timestamp);

        SvixSignature.Verify(key, Svix(id, timestamp, signature), Encoding.UTF8.GetBytes(body), at).ShouldBeNull();
        SvixSignature.Sign(key, id, timestamp, Encoding.UTF8.GetBytes(body)).ShouldBe(signature);
        // Svix's Standard Webhooks header names too.
        SvixSignature.Verify(key, Svix(id, timestamp, signature, "webhook"), Encoding.UTF8.GetBytes(body), at).ShouldBeNull();
        // A body changed by one character, another id or another secret does not.
        SvixSignature.Verify(key, Svix(id, timestamp, signature), Encoding.UTF8.GetBytes(body + " "), at).ShouldBe(WebhookRefusal.BadSignature);
        SvixSignature.Verify(key, Svix(id + "x", timestamp, signature), Encoding.UTF8.GetBytes(body), at).ShouldBe(WebhookRefusal.BadSignature);
        SvixSignature.Verify(SvixSignature.Key("whsec_" + Convert.ToBase64String(new byte[24]))!, Svix(id, timestamp, signature), Encoding.UTF8.GetBytes(body), at)
            .ShouldBe(WebhookRefusal.BadSignature);
    }

    [Fact]
    public void A_signature_must_be_recent_present_and_of_version_one()
    {
        var key = SvixSignature.Key("whsec_plJ3nmyCDGBKInavdOK15jsl")!;
        var body = Encoding.UTF8.GetBytes("{\"event_type\":\"ping\",\"data\":{\"success\":true}}");
        const string signature = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";

        // Five minutes either way: a recorded delivery cannot be sent again later, a clock a little off still works.
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, signature), body, Sent.AddMinutes(5)).ShouldBeNull();
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, signature), body, Sent.AddMinutes(5).AddSeconds(1)).ShouldBe(WebhookRefusal.Stale);
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, signature), body, Sent.AddMinutes(-6)).ShouldBe(WebhookRefusal.Stale);
        var withoutTime = Svix("msg_loFOjxBNrRLzqYUf", 1731705121, signature);
        withoutTime.Remove("svix-timestamp");
        SvixSignature.Verify(key, withoutTime, body, Sent).ShouldBe(WebhookRefusal.Unsigned);
        SvixSignature.Verify(key, new HeaderDictionary(), body, Sent).ShouldBe(WebhookRefusal.Unsigned);
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, "v2,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0="), body, Sent)
            .ShouldBe(WebhookRefusal.BadSignature);
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, "v1,not-base64"), body, Sent).ShouldBe(WebhookRefusal.BadSignature);
        // While the vendor rotates its secret it signs with both: one match is enough.
        SvixSignature.Verify(key, Svix("msg_loFOjxBNrRLzqYUf", 1731705121, $"v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= {signature}"), body, Sent).ShouldBeNull();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")]
    [InlineData("whsec_")]
    [InlineData("whsec_short")]
    [InlineData("whsec_not base64!")]
    public void Only_a_whsec_secret_is_a_key(string? secret) => SvixSignature.Key(secret).ShouldBeNull();

    [Theory]
    [InlineData("incident_report.created", "incident_report.created")]
    [InlineData("Ticket", "ticket")]
    [InlineData("Ticket from Ola Nordmann", "unknown")]
    [InlineData("https://evil.invalid/x", "unknown")]
    [InlineData(null, "unknown")]
    public void An_event_name_is_kept_only_as_an_identifier(string? type, string kept) => WebhookEvents.Name(type).ShouldBe(kept);

    private static WebhookDelivery Signed(string body, string secret = "whsec_plJ3nmyCDGBKInavdOK15jsl", string id = "msg_1")
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var signature = SvixSignature.Sign(SvixSignature.Key(secret)!, id, Sent.ToUnixTimeSeconds(), bytes);
        return new WebhookDelivery(Svix(id, Sent.ToUnixTimeSeconds(), signature), null, bytes);
    }

    private static HuntressWebhookSource Huntress(bool enabled = true, bool webhook = true, string? secret = "whsec_plJ3nmyCDGBKInavdOK15jsl") =>
        new(Options.Create(new HuntressOptions { Enabled = enabled, WebhookEnabled = webhook, WebhookSecret = secret }));

    [Theory]
    [InlineData("incident_report.created", true)]
    [InlineData("incident_report.comment_added", true)]
    [InlineData("incident_report.closed", true)]
    [InlineData("escalation.created", true)]
    [InlineData("escalation.overdue", true)]
    [InlineData("escalation.closed", true)]
    [InlineData("platform_action.created", true)]
    [InlineData("platform_action.overdue", true)]
    [InlineData("platform_action.closed", true)]
    // Nothing the API can read: counted, nothing started.
    [InlineData("platform_action.notification", false)]
    [InlineData("account_notice.notification", false)]
    [InlineData("ping", false)]
    public void Huntress_events_of_reports_escalations_and_platform_actions_start_the_alert_read(string eventType, bool reads)
    {
        var check = Huntress().Check(Signed($$"""{"event_type":"{{eventType}}","id":17,"organization":{"id":4,"name":"Synthetic AS"},"subject":"Synthetic"}"""), Sent);

        EarlyRead[] expected = reads ? [new EarlyRead(HuntressAlertSyncJob.JobId)] : [];
        check.Refusal.ShouldBeNull();
        check.Reading!.EventType.ShouldBe(eventType);
        check.Reading.Reads.ShouldBe(expected);
    }

    [Fact]
    public void A_huntress_delivery_proves_its_sender_before_its_body_is_read()
    {
        var source = Huntress();
        source.Check(Signed("{\"event_type\":\"incident_report.created\"}", secret: "whsec_" + Convert.ToBase64String(new byte[24])), Sent)
            .Refusal.ShouldBe(WebhookRefusal.BadSignature);
        source.Check(new WebhookDelivery(new HeaderDictionary(), null, Encoding.UTF8.GetBytes("{\"event_type\":\"incident_report.created\"}")), Sent)
            .Refusal.ShouldBe(WebhookRefusal.Unsigned);
        // A signed body that is not an event is accepted and only counted.
        var reading = source.Check(Signed("not json"), Sent).Reading.ShouldNotBeNull();
        reading.EventType.ShouldBe("unknown");
        reading.Reads.ShouldBeEmpty();
    }

    [Fact]
    public void A_huntress_webhook_answers_only_when_it_and_its_integration_are_on_with_a_secret()
    {
        Huntress().IsEnabled.ShouldBeTrue();
        Huntress(enabled: false).IsEnabled.ShouldBeFalse();
        Huntress(webhook: false).IsEnabled.ShouldBeFalse();
        Huntress().ConfigurationProblem.ShouldBeNull();
        // Switched on without its secret: crm-web refuses to start rather than answer 404 while the page says "on".
        Huntress(secret: null).IsEnabled.ShouldBeFalse();
        Huntress(secret: "not-a-secret").ConfigurationProblem.ShouldNotBeNull().ShouldNotContain("not-a-secret");
        Huntress(webhook: false, secret: null).ConfigurationProblem.ShouldBeNull();
    }

    private const string AteraKey = "synthetic-atera-webhook-key-0123456789abcdef";

    private static AteraWebhookSource Atera(bool webhook = true, string? key = AteraKey) =>
        new(Options.Create(new AteraOptions { Enabled = true, WebhookEnabled = webhook, WebhookKey = key }));

    private static WebhookDelivery Keyed(string? key, string body) => new(new HeaderDictionary(), key, Encoding.UTF8.GetBytes(body));

    [Theory]
    [InlineData("""{"TicketID":4711}""", "4711")]
    [InlineData("""{"ticketId":"4711","EventType":"Ticket status changed"}""", "4711")]
    [InlineData("""{"ticket_id":4711}""", "4711")]
    [InlineData("""{"Ticket":{"TicketID":4711,"TicketTitle":"Synthetic"}}""", "4711")]
    [InlineData("""{"ticket":{"id":4711}}""", "4711")]
    // Atera does not document its body: without a ticket's id the list of changes still names the ticket.
    [InlineData("""{"id":4711}""", null)]
    [InlineData("""{"TicketID":-1}""", null)]
    [InlineData("""{"TicketID":"47 11"}""", null)]
    [InlineData("""[4711]""", null)]
    [InlineData("""not json""", null)]
    public void An_atera_delivery_with_the_key_starts_the_conversation_read_and_names_its_ticket(string body, string? ticket)
    {
        var check = Atera().Check(Keyed(AteraKey, body), Sent);

        EarlyRead[] expected = [new EarlyRead(AteraTicketConversationSyncJob.JobId, ticket)];
        check.Refusal.ShouldBeNull();
        check.Reading!.Reads.ShouldBe(expected);
    }

    [Fact]
    public void An_atera_delivery_names_its_event_only_as_an_identifier()
    {
        Atera().Check(Keyed(AteraKey, """{"Event":"ticket.closed"}"""), Sent).Reading!.EventType.ShouldBe("ticket.closed");
        Atera().Check(Keyed(AteraKey, """{"EventType":"Ticket status changed"}"""), Sent).Reading!.EventType.ShouldBe("unknown");
        Atera().Check(Keyed(AteraKey, "{}"), Sent).Reading!.EventType.ShouldBe("ticket");
    }

    [Fact]
    public void An_atera_delivery_without_the_right_key_is_refused()
    {
        Atera().Check(Keyed(null, """{"TicketID":4711}"""), Sent).Refusal.ShouldBe(WebhookRefusal.Unsigned);
        Atera().Check(Keyed(AteraKey[..^1] + "X", """{"TicketID":4711}"""), Sent).Refusal.ShouldBe(WebhookRefusal.BadSignature);
        Atera().Check(Keyed(AteraKey + "X", """{"TicketID":4711}"""), Sent).Refusal.ShouldBe(WebhookRefusal.BadSignature);
        // A key too short to guess safely is never accepted, and keeps crm-web from starting while the webhook is on.
        Atera(key: "short").IsEnabled.ShouldBeFalse();
        Atera(key: "short").Check(Keyed("short", "{}"), Sent).Refusal.ShouldBe(WebhookRefusal.BadSignature);
        Atera(key: "short").ConfigurationProblem.ShouldNotBeNull().ShouldNotContain("short");
        Atera(key: "a key with spaces that is long enough to pass the length").IsEnabled.ShouldBeFalse();
        Atera(webhook: false).IsEnabled.ShouldBeFalse();
        Atera().IsEnabled.ShouldBeTrue();
    }
}
