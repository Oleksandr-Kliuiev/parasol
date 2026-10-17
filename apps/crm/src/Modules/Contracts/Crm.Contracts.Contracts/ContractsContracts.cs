using Crm.SharedKernel.Domain;

namespace Crm.Contracts.Contracts;

public enum ContractType
{
    Msp,
    Licensing,
    PowerOfficeSupport,
    HourBank,
    Mixed,
}

/// <summary>Draft → Active → (Suspended) → NoticeGiven → Ended; renewal keeps the contract Active (docs/02 §4.5).</summary>
public enum ContractStatus
{
    Draft,
    Active,
    Suspended,
    NoticeGiven,
    Ended,
}

public enum InvoiceFrequency
{
    Monthly,
    Quarterly,
    Yearly,
}

public enum InvoiceTiming
{
    InAdvance,
    InArrears,
}

/// <summary>Which Atera devices a per-device line counts (BR-CON-01).</summary>
public enum DeviceFilter
{
    All,
    Workstations,
    Servers,
}

/// <summary>How a contract line gets its quantity for a billing period (BR-CON-01, BR-CON-02).</summary>
public enum QuantityModel
{
    Fixed,
    PerAteraDevice,
    PerM365User,
    PerSubscription,
    Manual,
}

/// <summary>Service level of an organization's current contract, e.g. for the Atera "SLA" custom field.</summary>
public sealed record OrganizationSla(Guid OrganizationId, Guid? ContractId, string? PolicyName, string? AteraValue);

/// <summary>Support hours of an SLA; outside them work is after hours (BR-TIM-06).</summary>
public enum SupportHours
{
    Business8x5,
    Extended12x5,
    Always24x7,
}

public sealed record HourBankBalance(Guid Id, string Name, decimal RemainingHours, decimal? OverageRate, DateOnly ValidFrom, DateOnly? ValidTo);

/// <summary>What the active contract on a date says about billing time (BR-TIM-03).</summary>
public sealed record ContractBillingTerms(
    Guid ContractId,
    string Number,
    string? PriceCategory,
    SupportHours? Coverage,
    decimal IncludedHoursPerMonth,
    IReadOnlyList<string> CoveredWorkTypes,
    decimal AfterHoursMultiplier,
    decimal? SlaOverageRate,
    IReadOnlyDictionary<Guid, decimal> IndividualPrices);

public sealed record OrganizationBillingTerms(ContractBillingTerms? Contract, IReadOnlyList<HourBankBalance> HourBanks);

/// <summary>Response and resolution targets of one priority, in minutes of support time (BR-SRV-05).</summary>
public sealed record SlaPriorityTarget(int ResponseMinutes, int ResolutionMinutes);

/// <summary>
/// What the customer's contract promises on a date: the support hours the SLA clock runs in and the target per priority
/// (P1 is the most urgent). An organization without a live SLA policy has no targets and is reported as "no SLA".
/// </summary>
public sealed record SlaTargets(
    Guid OrganizationId,
    Guid ContractId,
    string ContractNumber,
    string PolicyName,
    SupportHours Coverage,
    SlaPriorityTarget P1,
    SlaPriorityTarget P2,
    SlaPriorityTarget P3,
    SlaPriorityTarget P4)
{
    public SlaPriorityTarget For(int priority) => priority switch
    {
        1 => P1,
        2 => P2,
        3 => P3,
        _ => P4,
    };
}

public sealed record HourBankConsumption(Guid HourBankId, decimal Hours, decimal OverageHours, decimal RemainingHours);

/// <summary>Immutable ledger facts for a source prefix, including an already committed reversal; no current bank filtering.</summary>
public sealed record SourceBankUsage(string SourceId, Guid HourBankId, DateOnly Date, decimal RequestedHours,
    decimal ConsumedHours, decimal ReturnedHours, bool Consistent);

public enum ReminderKind
{
    ContractEnding,
    NoticeDeadline,
    HourBankLow,
}

/// <summary>Monthly recurring value of the live contracts on a date, and how it splits by contract type.</summary>
public sealed record RecurringRevenue(decimal MonthlyTotal, IReadOnlyDictionary<ContractType, decimal> ByType, int Contracts);

/// <summary>A contract that ends within the horizon, for the renewal list on the dashboard (FR-CON-04).</summary>
public sealed record RenewalDue(
    Guid ContractId, string Number, string Title, Guid OrganizationId, DateOnly EndDate, int DaysLeft, bool AutoRenew, DateOnly? NoticeDeadline, Guid? OwnerId);

/// <summary>
/// A live contract line as billing sees it; prices are resolved by the caller when <see cref="UnitPrice"/> is null.
/// <see cref="LineId"/> is the version, <see cref="SeriesId"/> the service across its versions (BR-CON-03).
/// </summary>
public sealed record BillableContractLine(
    Guid ContractId,
    string ContractNumber,
    Guid OrganizationId,
    Guid LineId,
    Guid SeriesId,
    Guid ProductId,
    string? Description,
    QuantityModel QuantityModel,
    DeviceFilter DeviceFilter,
    decimal Quantity,
    decimal? UnitPrice,
    decimal DiscountPct,
    string? PriceCategory,
    InvoiceFrequency InvoiceFrequency,
    InvoiceTiming InvoiceTiming,
    DateOnly ContractStart,
    DateOnly LineValidFrom,
    DateOnly? LineValidTo,
    string? CustomerReference);

/// <summary>
/// Hours a customer bought in a period; billed once, through the hour-bank product of the contract. <see cref="EntryId"/> is
/// the purchase movement, so two purchases of the same bank are two charges.
/// </summary>
public sealed record HourBankPurchase(
    Guid EntryId, Guid HourBankId, Guid OrganizationId, Guid? ContractId, string Name, DateOnly Date, decimal Hours, decimal? OverageRate, string? Description);

/// <summary>Public API of the Contracts module for other modules and integrations.</summary>
public interface IContractsApi
{
    /// <summary>SLA of the organization's active contract with an SLA policy (the latest started one), or nulls when there is none.</summary>
    Task<OrganizationSla> GetOrganizationSlaAsync(Guid organizationId, CancellationToken cancellationToken);

    /// <summary>
    /// Deducts approved time from an hour bank (BR-CON-05). Idempotent per <paramref name="sourceType"/> and <paramref name="sourceId"/>:
    /// a repeated call returns the first result.
    /// </summary>
    Task<HourBankConsumption?> ConsumeHoursAsync(
        Guid hourBankId, decimal hours, DateOnly date, string description, string sourceType, string sourceId, CancellationToken cancellationToken);

    /// <summary>Gives back hours consumed by <paramref name="sourceType"/>/<paramref name="sourceId"/>, e.g. when an approval is withdrawn. Idempotent.</summary>
    Task ReverseConsumptionAsync(string sourceType, string sourceId, CancellationToken cancellationToken);

    /// <summary>All consumption/reversal receipts for an exact caller-owned source prefix, even on closed or depleted banks.</summary>
    Task<IReadOnlyList<SourceBankUsage>> GetSourceBankUsageAsync(string sourceType, string sourceIdPrefix, CancellationToken cancellationToken);

    /// <summary>Products the organization has a live contract line for on a date; a CSP subscription outside this set is not billed (BR-LIC-03).</summary>
    Task<IReadOnlySet<Guid>> GetContractedProductsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// The contracted products of many organizations in one query (DEV-12): a summary over every subscription asks once instead
    /// of once per customer. Organizations without a live contract line are absent from the answer.
    /// </summary>
    Task<IReadOnlyDictionary<Guid, IReadOnlySet<Guid>>> GetContractedProductsAsync(IReadOnlyCollection<Guid> organizationIds, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// Billing terms on a date: the organization's active contract with an SLA (latest started) or, without SLA, the latest active contract,
    /// plus active hour banks with hours left, earliest expiry first.
    /// </summary>
    Task<OrganizationBillingTerms> GetBillingTermsAsync(Guid organizationId, DateOnly date, CancellationToken cancellationToken);

    /// <summary>
    /// Lines of live contracts that are in force during the period, newest version of each line series only. Which of them fall due
    /// in the period is decided by the caller from the contract's invoice frequency and timing (BR-BIL-01).
    /// </summary>
    Task<IReadOnlyList<BillableContractLine>> GetBillableLinesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>Hour-bank purchases recorded in the period (BR-CON-05), so a renewed or topped-up package is invoiced once.</summary>
    Task<IReadOnlyList<HourBankPurchase>> GetHourBankPurchasesAsync(DateOnly periodStart, DateOnly periodEnd, CancellationToken cancellationToken);

    /// <summary>Recurring value of the live contracts on a date (FR-RPT-01): monthly amounts, quarterly and yearly lines divided down.</summary>
    Task<RecurringRevenue> GetRecurringRevenueAsync(DateOnly date, CancellationToken cancellationToken);

    /// <summary>SLA targets of the organizations that have a live contract with a policy on the date (FR-SRV-04).</summary>
    Task<IReadOnlyList<SlaTargets>> GetSlaTargetsAsync(DateOnly date, CancellationToken cancellationToken);

    /// <summary>Live contracts whose end date falls within <paramref name="days"/>, soonest first.</summary>
    Task<IReadOnlyList<RenewalDue>> GetRenewalsAsync(DateOnly from, int days, CancellationToken cancellationToken);

    /// <summary>Reminders (contract ending, notice deadline, low hour bank) whose due date has passed and nobody has acknowledged (pilot KPI, DEV-22).</summary>
    Task<int> CountOverdueRemindersAsync(DateOnly today, CancellationToken cancellationToken);
}

public sealed record ContractActivated(Guid ContractId, Guid OrganizationId) : DomainEvent;

public sealed record ContractRenewed(Guid ContractId, Guid OrganizationId, DateOnly NewEndDate) : DomainEvent;

public sealed record ContractEnded(Guid ContractId, Guid OrganizationId) : DomainEvent;

/// <summary>A renewal or end-date reminder was created (FR-CON-04).</summary>
public sealed record ContractEnding(Guid ContractId, Guid OrganizationId, DateOnly EndDate, int DaysLeft) : DomainEvent;

/// <summary>
/// A reminder was created (FR-CON-04, BR-CON-05). It carries what a notification needs to say, so the notifications module
/// does not have to look the contract up again.
/// </summary>
public sealed record ReminderRaised(
    Guid ReminderId,
    ReminderKind Kind,
    Guid OrganizationId,
    Guid? AssigneeId,
    DateOnly DueDate,
    int? DaysBefore,
    Guid? ContractId,
    string? ContractNumber,
    Guid? HourBankId,
    string? HourBankName,
    decimal? RemainingHours) : DomainEvent;

/// <summary>Raised whenever the SLA an organization is entitled to may have changed.</summary>
public sealed record OrganizationSlaChanged(Guid OrganizationId) : DomainEvent;

public sealed record HourBankLow(Guid HourBankId, Guid OrganizationId, decimal RemainingHours, decimal PurchasedHours) : DomainEvent;
