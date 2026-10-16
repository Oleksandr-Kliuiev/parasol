using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Crm.Activities.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Reads the signed-in user's mailbox, and the shared mailboxes they may open, for messages exchanged with a customer
/// (FR-ACT-03). Only metadata leaves Exchange: subject, participants, time and a link — never the body (SEC-GDPR-06).
/// </summary>
internal sealed class GraphMailbox(HttpClient http, IOptions<GraphOptions> options, ILogger<GraphMailbox> logger) : IUserMailbox
{
    private const string Select = "$select=id,internetMessageId,subject,bodyPreview,from,toRecipients,receivedDateTime,hasAttachments,webLink";

    public bool IsAvailable => options.Value.Enabled && options.Value.MailEnabled;

    public async Task<IReadOnlyList<MailMessage>> SearchAsync(MailSearch search, CancellationToken cancellationToken)
    {
        var terms = search.Addresses.Concat(search.Domains)
            .Select(term => term.Trim())
            .Where(term => term.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(6)
            .ToList();
        if (terms.Count == 0)
        {
            return [];
        }

        var mailboxes = new List<string?> { null };
        mailboxes.AddRange(options.Value.SharedMailboxes.Where(m => !string.IsNullOrWhiteSpace(m)));

        var found = new Dictionary<string, MailMessage>(StringComparer.OrdinalIgnoreCase);
        foreach (var mailbox in mailboxes)
        {
            foreach (var term in terms)
            {
                foreach (var message in await ReadAsync(mailbox, term, search.Take, cancellationToken))
                {
                    // The same conversation can match several participants; the internet message id is the stable key.
                    found.TryAdd(message.InternetMessageId, message);
                }
            }
        }

        return found.Values.OrderByDescending(m => m.ReceivedAt).Take(search.Take).ToList();
    }

    private async Task<IReadOnlyList<MailMessage>> ReadAsync(string? mailbox, string term, int take, CancellationToken cancellationToken)
    {
        var scope = mailbox is null ? "me" : $"users/{Uri.EscapeDataString(mailbox)}";
        var url = $"{scope}/messages?$search=\"participants:{Uri.EscapeDataString(KqlTerm(term))}\"&{Select}&$top={Math.Clamp(take, 1, 50)}";
        using var response = await http.GetAsync(url, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.NotFound)
        {
            // The user may not open this shared mailbox — that is a configuration fact, not an error to show them.
            logger.LogDebug("Mailbox {Mailbox} is not accessible for the signed-in user.", mailbox ?? "me");
            return [];
        }

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"Graph mail returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
        }

        var page = await response.Content.ReadFromJsonAsync<GraphMailMessagePage>(cancellationToken);
        return (page?.Value ?? []).Select(m => Map(m, mailbox ?? "me")).ToList();
    }

    /// <summary>
    /// A search term goes inside a quoted KQL phrase, so a double quote or a backslash would end it and widen the search
    /// (F-G1-13): both and every control character are dropped. An address or a domain has none of them.
    /// </summary>
    internal static string KqlTerm(string term) =>
        new(term.Where(c => c is not ('"' or '\\') && !char.IsControl(c)).ToArray());

    internal static MailMessage Map(GraphMailMessage message, string mailbox) => new(
        message.Id,
        message.InternetMessageId ?? message.Id,
        message.Subject ?? "(uten emne)",
        message.BodyPreview is { Length: > 0 } preview ? preview[..Math.Min(preview.Length, 180)] : null,
        message.From?.EmailAddress?.Address ?? string.Empty,
        message.From?.EmailAddress?.Name,
        (message.ToRecipients ?? []).Select(r => r.EmailAddress?.Address ?? string.Empty).Where(a => a.Length > 0).ToList(),
        message.ReceivedDateTime ?? DateTimeOffset.MinValue,
        message.HasAttachments ?? false,
        message.WebLink,
        mailbox);
}

internal sealed record GraphMailMessage(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("internetMessageId")] string? InternetMessageId,
    [property: JsonPropertyName("subject")] string? Subject,
    [property: JsonPropertyName("bodyPreview")] string? BodyPreview,
    [property: JsonPropertyName("from")] GraphRecipient? From,
    [property: JsonPropertyName("toRecipients")] IReadOnlyList<GraphRecipient>? ToRecipients,
    [property: JsonPropertyName("receivedDateTime")] DateTimeOffset? ReceivedDateTime,
    [property: JsonPropertyName("hasAttachments")] bool? HasAttachments,
    [property: JsonPropertyName("webLink")] string? WebLink);

internal sealed record GraphMailMessagePage([property: JsonPropertyName("value")] IReadOnlyList<GraphMailMessage> Value);
