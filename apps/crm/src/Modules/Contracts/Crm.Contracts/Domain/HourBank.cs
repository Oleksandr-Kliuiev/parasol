using Crm.Contracts.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Contracts.Domain;

public enum HourBankStatus
{
    Active,
    Closed,
}

public enum HourBankEntryKind
{
    Purchase,
    Consumption,
    Adjustment,
}

/// <summary>Prepaid hours (klippekort). The balance is kept on the bank and every movement is a ledger entry (BR-CON-05).</summary>
public sealed class HourBank : AuditableEntity
{
    public const decimal DefaultLowBalancePct = 20m;

    private HourBank() { }

    public Guid OrganizationId { get; private set; }
    public Guid? ContractId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public DateOnly ValidFrom { get; private set; }
    public DateOnly? ValidTo { get; private set; }
    public decimal PurchasedHours { get; private set; }
    public decimal UsedHours { get; private set; }

    /// <summary>Hours consumed after the balance reached zero; billed at <see cref="OverageRate"/>.</summary>
    public decimal OverageHours { get; private set; }

    public decimal? OverageRate { get; private set; }
    public decimal LowBalancePct { get; private set; } = DefaultLowBalancePct;
    public DateTimeOffset? LowBalanceNotifiedAt { get; private set; }
    public HourBankStatus Status { get; private set; }
    public Guid? MovedByMergeId { get; private set; }
    public Guid? PreviousOrganizationId { get; private set; }

    public decimal RemainingHours => Math.Max(0, PurchasedHours - UsedHours);

    public bool IsLow => PurchasedHours > 0 && RemainingHours < PurchasedHours * LowBalancePct / 100m;

    public static Result<(HourBank Bank, HourBankEntry Entry)> Create(
        Guid organizationId, Guid? contractId, string name, decimal hours, DateOnly validFrom, DateOnly? validTo, decimal? overageRate, decimal? lowBalancePct)
    {
        if (validTo is { } to && to < validFrom)
        {
            return ContractErrors.InvalidPeriod;
        }

        var bank = new HourBank
        {
            OrganizationId = organizationId,
            ContractId = contractId,
            Name = name.Trim(),
            ValidFrom = validFrom,
            ValidTo = validTo,
            OverageRate = overageRate,
            LowBalancePct = lowBalancePct ?? DefaultLowBalancePct,
            Status = HourBankStatus.Active,
        };
        var entry = bank.Purchase(hours, validFrom, "Initial purchase");
        return (bank, entry);
    }

    public void UpdateTerms(string name, DateOnly? validTo, decimal? overageRate, decimal lowBalancePct)
    {
        Name = name.Trim();
        ValidTo = validTo;
        OverageRate = overageRate;
        LowBalancePct = lowBalancePct;
    }

    public HourBankEntry Purchase(decimal hours, DateOnly date, string? description)
    {
        PurchasedHours += hours;
        if (!IsLow)
        {
            LowBalanceNotifiedAt = null;
        }

        return HourBankEntry.Create(Id, HourBankEntryKind.Purchase, date, hours, 0, description, null, null);
    }

    /// <summary>Deducts hours; what exceeds the balance is recorded as overage. Raises <see cref="HourBankLow"/> once per top-up.</summary>
    public Result<HourBankEntry> Consume(decimal hours, DateOnly date, string? description, string? sourceType, string? sourceId, DateTimeOffset now)
    {
        if (Status == HourBankStatus.Closed)
        {
            return Error.Conflict("CON_HOUR_BANK_CLOSED", "The hour bank is closed.");
        }

        var fromBank = Math.Min(hours, RemainingHours);
        var overage = hours - fromBank;
        UsedHours += fromBank;
        OverageHours += overage;
        RaiseIfLow(now);
        return HourBankEntry.Create(Id, HourBankEntryKind.Consumption, date, -fromBank, overage, description, sourceType, sourceId);
    }

    /// <summary>Manual correction: positive hours give time back, negative hours take it.</summary>
    public HourBankEntry Adjust(decimal hours, DateOnly date, string description, DateTimeOffset now)
    {
        UsedHours -= hours;
        if (UsedHours < 0)
        {
            PurchasedHours -= UsedHours;
            UsedHours = 0;
        }

        if (!IsLow)
        {
            LowBalanceNotifiedAt = null;
        }
        else
        {
            RaiseIfLow(now);
        }

        return HourBankEntry.Create(Id, HourBankEntryKind.Adjustment, date, hours, 0, description, null, null);
    }

    public void Close() => Status = HourBankStatus.Closed;

    public void MoveToOrganization(Guid targetOrganizationId, Guid mergeId)
    {
        PreviousOrganizationId = OrganizationId;
        MovedByMergeId = mergeId;
        OrganizationId = targetOrganizationId;
    }

    public void UndoMove()
    {
        OrganizationId = PreviousOrganizationId ?? OrganizationId;
        PreviousOrganizationId = null;
        MovedByMergeId = null;
    }

    private void RaiseIfLow(DateTimeOffset now)
    {
        if (IsLow && LowBalanceNotifiedAt is null)
        {
            LowBalanceNotifiedAt = now;
            Raise(new HourBankLow(Id, OrganizationId, RemainingHours, PurchasedHours));
        }
    }
}

public sealed class HourBankEntry : AuditableEntity
{
    private HourBankEntry() { }

    public Guid HourBankId { get; private set; }
    public HourBankEntryKind Kind { get; private set; }
    public DateOnly Date { get; private set; }

    /// <summary>Change of the balance: positive for purchases, negative for consumption.</summary>
    public decimal Hours { get; private set; }

    public decimal OverageHours { get; private set; }
    public string? Description { get; private set; }

    /// <summary>Origin of a consumption (e.g. a time entry), unique so repeated deliveries are ignored.</summary>
    public string? SourceType { get; private set; }

    public string? SourceId { get; private set; }

    /// <summary>Links a manual movement to what caused it, so the same cause cannot be applied twice.</summary>
    internal void AttachSource(string sourceType, string sourceId)
    {
        SourceType = sourceType;
        SourceId = sourceId;
    }

    internal static HourBankEntry Create(
        Guid bankId, HourBankEntryKind kind, DateOnly date, decimal hours, decimal overage, string? description, string? sourceType, string? sourceId) => new()
    {
        HourBankId = bankId,
        Kind = kind,
        Date = date,
        Hours = hours,
        OverageHours = overage,
        Description = string.IsNullOrWhiteSpace(description) ? null : description.Trim(),
        SourceType = sourceType,
        SourceId = sourceId,
    };
}

/// <summary>
/// Something a user must act on: a contract that ends in 60/30/7 days, a notice deadline or a low hour bank. Shown in "My day"
/// until acknowledged; e-mail delivery comes with notifications (docs/08, S8).
/// </summary>
public sealed class Reminder : AuditableEntity
{
    private Reminder() { }

    public ReminderKind Kind { get; private set; }
    public Guid OrganizationId { get; private set; }
    public Guid? ContractId { get; private set; }
    public Guid? HourBankId { get; private set; }
    public Guid? AssigneeId { get; private set; }
    public DateOnly DueDate { get; private set; }

    /// <summary>Days before the end date for <see cref="ReminderKind.ContractEnding"/> (60, 30 or 7).</summary>
    public int? DaysBefore { get; private set; }

    /// <summary>Makes creation idempotent: kind + subject + reference (e.g. "30@2026-12-31").</summary>
    public string DeduplicationKey { get; private set; } = string.Empty;

    public DateTimeOffset? AcknowledgedAt { get; private set; }
    public Guid? AcknowledgedBy { get; private set; }

    public static Reminder ForContract(ReminderKind kind, Contract contract, DateOnly dueDate, int? daysBefore, string reference, Guid? assigneeId)
    {
        var reminder = new Reminder
        {
            Kind = kind,
            OrganizationId = contract.OrganizationId,
            ContractId = contract.Id,
            AssigneeId = assigneeId,
            DueDate = dueDate,
            DaysBefore = daysBefore,
            DeduplicationKey = $"{kind}:{contract.Id}:{reference}",
        };
        reminder.Raise(new ReminderRaised(
            reminder.Id, kind, contract.OrganizationId, assigneeId, dueDate, daysBefore, contract.Id, contract.Number, null, null, null));
        return reminder;
    }

    public static Reminder ForHourBank(HourBank bank, Guid? assigneeId, DateOnly today, DateTimeOffset notifiedAt)
    {
        var reminder = new Reminder
        {
            Kind = ReminderKind.HourBankLow,
            OrganizationId = bank.OrganizationId,
            ContractId = bank.ContractId,
            HourBankId = bank.Id,
            AssigneeId = assigneeId,
            DueDate = today,
            DeduplicationKey = $"{ReminderKind.HourBankLow}:{bank.Id}:{notifiedAt.ToUnixTimeSeconds()}",
        };
        reminder.Raise(new ReminderRaised(
            reminder.Id, ReminderKind.HourBankLow, bank.OrganizationId, assigneeId, today, null, bank.ContractId, null, bank.Id, bank.Name, bank.RemainingHours));
        return reminder;
    }

    public void RaiseEnding(int daysLeft) => Raise(new ContractEnding(ContractId!.Value, OrganizationId, DueDate, daysLeft));

    public void Acknowledge(Guid? userId, DateTimeOffset at)
    {
        AcknowledgedAt ??= at;
        AcknowledgedBy ??= userId;
    }
}

/// <summary>Renewal reminder schedule (FR-CON-04, BR-CON-04).</summary>
public static class RenewalSchedule
{
    public static readonly int[] ReminderDays = [60, 30, 7];

    /// <summary>The reminder step due today: the smallest of 60/30/7 that is not less than the days left, so a late start does not flood the user.</summary>
    public static int? DueStep(DateOnly endDate, DateOnly today)
    {
        var daysLeft = endDate.DayNumber - today.DayNumber;
        if (daysLeft < 0)
        {
            return null;
        }

        return ReminderDays.Where(d => daysLeft <= d).Order().Select(d => (int?)d).FirstOrDefault();
    }

    /// <summary>For auto-renewing contracts a task appears notice period + 30 days before the end date.</summary>
    public static bool NoticeTaskDue(Contract contract, DateOnly today) =>
        contract is { Status: ContractStatus.Active or ContractStatus.Suspended, AutoRenew: true, EndDate: { } end } &&
        end.DayNumber - today.DayNumber is var daysLeft && daysLeft >= contract.NoticePeriodDays && daysLeft <= contract.NoticePeriodDays + 30;
}
