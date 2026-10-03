using System.Globalization;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Notifications.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Notifications.Features;

/// <summary>
/// A contract or hour-bank reminder (FR-CON-04, BR-CON-05) becomes a notice for the person responsible: the contract owner,
/// or the account manager of the customer.
/// </summary>
internal sealed class ReminderRaisedHandler(INotificationsApi notifications, ICustomersApi customers) : IDomainEventHandler<ReminderRaised>
{
    public async Task HandleAsync(ReminderRaised domainEvent, CancellationToken cancellationToken)
    {
        var organization = await customers.GetOrganizationAsync(domainEvent.OrganizationId, cancellationToken);
        var recipient = domainEvent.AssigneeId ?? organization?.AccountManagerId;
        if (recipient is not { } target)
        {
            return;
        }

        var kind = domainEvent.Kind switch
        {
            ReminderKind.ContractEnding => NotificationKind.ContractEnding,
            ReminderKind.NoticeDeadline => NotificationKind.NoticeDeadline,
            _ => NotificationKind.HourBankLow,
        };

        var parameters = new Dictionary<string, string>
        {
            ["organization"] = organization?.Name ?? "—",
            ["date"] = domainEvent.DueDate.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture),
        };
        if (domainEvent.ContractNumber is { } number)
        {
            parameters["number"] = number;
        }

        if (domainEvent.DaysBefore is { } days)
        {
            parameters["days"] = days.ToString(CultureInfo.InvariantCulture);
        }

        if (domainEvent.HourBankName is { } bankName)
        {
            parameters["name"] = bankName;
        }

        if (domainEvent.RemainingHours is { } hours)
        {
            parameters["hours"] = NotificationTexts.Hours(hours);
        }

        var link = domainEvent.HourBankId is { } bankId
            ? $"/contracts/hour-banks/{bankId}"
            : domainEvent.ContractId is { } contractId ? $"/contracts/{contractId}" : "/";

        await notifications.EnqueueAsync(
            new NotificationRequest(
                kind,
                target,
                // The reminder is already deduplicated per contract and step, so its id is the natural key.
                $"reminder:{domainEvent.ReminderId}",
                parameters,
                domainEvent.OrganizationId,
                link,
                domainEvent.DueDate,
                Warning: domainEvent.Kind == ReminderKind.NoticeDeadline),
            cancellationToken);
    }
}
