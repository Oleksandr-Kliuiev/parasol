using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Crm.Notifications.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Sends the notification digest through Microsoft Graph (<c>POST /users/{mailbox}/sendMail</c>, application permission
/// <c>Mail.Send</c> restricted to the sender mailbox — docs/05-integrations.md §1.3). The mailbox is a shared one, so the
/// digest never appears to come from a colleague.
/// </summary>
internal sealed class GraphMailSender(HttpClient http, IOptions<GraphMailOptions> options) : INotificationEmailSender
{
    public bool IsConfigured => options.Value.EmailEnabled && !string.IsNullOrWhiteSpace(options.Value.FromAddress);

    public async Task SendAsync(NotificationEmail email, CancellationToken cancellationToken)
    {
        var from = options.Value.FromAddress
                   ?? throw new InvalidOperationException("Notifications:FromAddress is not configured.");
        var payload = new GraphSendMail(
            new GraphMessage(
                email.Subject,
                new GraphBody("HTML", email.HtmlBody),
                [new GraphRecipient(new GraphAddress(email.ToAddress, email.ToName))]),
            SaveToSentItems: false);

        using var response = await http.PostAsJsonAsync($"users/{Uri.EscapeDataString(from)}/sendMail", payload, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"Graph sendMail returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
        }
    }
}

/// <summary>Settings the mail sender needs; the flag and the mailbox live with the other notification settings.</summary>
public sealed class GraphMailOptions
{
    public const string SectionName = "Notifications";

    /// <summary>Same flag as <c>Notifications:EmailEnabled</c>: without it nothing is sent.</summary>
    public bool EmailEnabled { get; set; }

    public string? FromAddress { get; set; }
}

internal sealed record GraphSendMail(
    [property: JsonPropertyName("message")] GraphMessage Message,
    [property: JsonPropertyName("saveToSentItems")] bool SaveToSentItems);

internal sealed record GraphMessage(
    [property: JsonPropertyName("subject")] string Subject,
    [property: JsonPropertyName("body")] GraphBody Body,
    [property: JsonPropertyName("toRecipients")] IReadOnlyList<GraphRecipient> ToRecipients)
{
    [JsonPropertyName("ccRecipients")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<GraphRecipient>? CcRecipients { get; init; }

    [JsonPropertyName("attachments")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<GraphFileAttachment>? Attachments { get; init; }
}

internal sealed record GraphBody(
    [property: JsonPropertyName("contentType")] string ContentType,
    [property: JsonPropertyName("content")] string Content);

internal sealed record GraphRecipient([property: JsonPropertyName("emailAddress")] GraphAddress EmailAddress);

internal sealed record GraphAddress(
    [property: JsonPropertyName("address")] string Address,
    [property: JsonPropertyName("name")] string? Name);
