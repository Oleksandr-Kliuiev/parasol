using System.Globalization;
using Crm.Billing.Contracts;
using Crm.Customers.Contracts;
using Crm.Notifications.Contracts;
using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.Options;

namespace Crm.Notifications.Features;

/// <summary>Shared wording and links for the channel cards (FR-ACT-04).</summary>
internal static class TeamsCards
{
    public static string? Link(NotificationsOptions options, string path) =>
        string.IsNullOrWhiteSpace(options.AppBaseUrl) ? null : $"{options.AppBaseUrl.TrimEnd('/')}{path}";

    public static string Money(decimal amount) =>
        string.Create(CultureInfo.InvariantCulture, $"{amount:N0}").Replace(",", " ", StringComparison.Ordinal) + " NOK";

    public static string Date(DateOnly date) => date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture);
}

/// <summary>
/// A won deal above the threshold is announced in the sales channel (docs/02 §5). Small deals stay out of the channel so
/// that what appears there is worth reading.
/// </summary>
internal sealed class WonDealTeamsHandler(
    ITeamsChannelSender teams,
    ICustomersApi customers,
    IOptions<NotificationsOptions> notifications,
    IOptions<TeamsNotificationOptions> options) : IDomainEventHandler<OpportunityWon>
{
    public async Task HandleAsync(OpportunityWon domainEvent, CancellationToken cancellationToken)
    {
        if (!teams.IsConfigured(TeamsChannel.Sales))
        {
            return;
        }

        // A deal is worth its one-off plus a year of recurring revenue.
        var value = domainEvent.OneOffAmount + (domainEvent.Mrr * 12);
        if (value < options.Value.WonDealThreshold)
        {
            return;
        }

        var organization = await customers.GetOrganizationAsync(domainEvent.OrganizationId, cancellationToken);
        var facts = new List<TeamsFact>
        {
            new("Kunde", organization?.Name ?? "—"),
            new("Engangsbeløp", TeamsCards.Money(domainEvent.OneOffAmount)),
            new("Per måned", TeamsCards.Money(domainEvent.Mrr)),
            new("Verdi første år", TeamsCards.Money(value)),
        };

        await teams.SendAsync(
            TeamsChannel.Sales,
            new TeamsCard(
                "Salg vunnet 🎉",
                $"{organization?.Name ?? "En kunde"} er vunnet.",
                facts,
                TeamsCards.Link(notifications.Value, $"/sales/opportunities/{domainEvent.OpportunityId}"),
                "Åpne salget"),
            cancellationToken);
    }
}

/// <summary>An approved billing run tells the finance channel that orders are on their way to PowerOffice.</summary>
internal sealed class BillingRunTeamsHandler(
    ITeamsChannelSender teams,
    IOptions<NotificationsOptions> notifications) : IDomainEventHandler<BillingRunApproved>
{
    public async Task HandleAsync(BillingRunApproved domainEvent, CancellationToken cancellationToken)
    {
        if (!teams.IsConfigured(TeamsChannel.Finance))
        {
            return;
        }

        await teams.SendAsync(
            TeamsChannel.Finance,
            new TeamsCard(
                "Faktureringskjøring godkjent",
                $"Perioden {TeamsCards.Date(domainEvent.PeriodStart)}–{TeamsCards.Date(domainEvent.PeriodEnd)} er godkjent og legges ut som salgsordrer.",
                [new TeamsFact("Periode", $"{TeamsCards.Date(domainEvent.PeriodStart)} – {TeamsCards.Date(domainEvent.PeriodEnd)}")],
                TeamsCards.Link(notifications.Value, $"/billing/runs/{domainEvent.RunId}"),
                "Åpne kjøringen"),
            cancellationToken);
    }
}

/// <summary>Thresholds for what reaches a channel; the webhook URLs themselves live with the Graph settings.</summary>
public sealed class TeamsNotificationOptions
{
    public const string SectionName = "Integrations:MicrosoftGraph:Teams";

    public decimal WonDealThreshold { get; set; } = 100_000m;
}
