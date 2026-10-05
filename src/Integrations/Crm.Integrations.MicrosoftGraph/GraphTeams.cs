using System.Globalization;
using System.Net.Http.Json;
using Crm.Notifications.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Posts an adaptive card to a team channel through a Power Automate Workflows webhook (FR-ACT-04). Office 365 connectors
/// were retired in May 2026, so the URL comes from a "When a Teams webhook request is received" flow; it carries its own
/// secret, which is why it lives in Key Vault and never in the repository.
/// </summary>
internal sealed class TeamsChannelSender(HttpClient http, IOptions<GraphOptions> options, ILogger<TeamsChannelSender> logger) : ITeamsChannelSender
{
    private GraphTeamsOptions Settings => options.Value.Teams;

    public bool IsConfigured(TeamsChannel channel) =>
        Settings.Enabled && Settings.Channels.TryGetValue(channel.ToString(), out var url) && !string.IsNullOrWhiteSpace(url);

    public async Task SendAsync(TeamsChannel channel, TeamsCard card, CancellationToken cancellationToken)
    {
        if (!IsConfigured(channel))
        {
            return;
        }

        var url = Settings.Channels[channel.ToString()];
        using var response = await http.PostAsJsonAsync(url, Payload(card), cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            // The status code only: the response text of a webhook can echo the card or the URL's secret (F-G4-16).
            logger.LogWarning("Teams channel {Channel} rejected the message with {Status}", channel, (int)response.StatusCode);
            // The queue tries again later and gives up after its attempts (DEV-07); a swallowed rejection was simply lost.
            throw new HttpRequestException($"Teams channel {channel} answered {(int)response.StatusCode}.", null, response.StatusCode);
        }
    }

    /// <summary>An adaptive card the Workflows connector understands; kept small so it reads well in the channel.</summary>
    internal static object Payload(TeamsCard card)
    {
        var elements = new List<object>
        {
            new { type = "TextBlock", text = card.Title, weight = "Bolder", size = "Medium", wrap = true },
            new { type = "TextBlock", text = card.Text, wrap = true },
        };

        if (card.Facts.Count > 0)
        {
            elements.Add(new
            {
                type = "FactSet",
                facts = card.Facts.Select(f => new { title = f.Label, value = f.Value }).ToList(),
            });
        }

        var content = new Dictionary<string, object?>
        {
            ["type"] = "AdaptiveCard",
            ["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json",
            ["version"] = "1.4",
            ["body"] = elements,
        };

        if (!string.IsNullOrWhiteSpace(card.Link))
        {
            content["actions"] = new[]
            {
                new { type = "Action.OpenUrl", title = card.LinkText ?? "Åpne i CRM", url = card.Link },
            };
        }

        return new
        {
            type = "message",
            attachments = new[]
            {
                new { contentType = "application/vnd.microsoft.card.adaptive", content },
            },
        };
    }

    internal static string Money(decimal amount) =>
        string.Create(CultureInfo.InvariantCulture, $"{amount:N0} NOK").Replace(",", " ", StringComparison.Ordinal);
}
