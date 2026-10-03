using Crm.Contracts.Contracts;
using Crm.SharedKernel.Time;
using Crm.TimeTracking.Contracts;

namespace Crm.TimeTracking.Domain;

public sealed record TariffInput(decimal Hours, bool Billable, string? WorkType, bool Onsite, bool AfterHours);

public sealed record TariffContext(
    ContractBillingTerms? Contract,
    decimal CoveredHoursUsedThisMonth,
    IReadOnlyList<HourBankBalance> HourBanks,
    decimal? ContractRate,
    decimal? CatalogRate,
    TimeTrackingOptions Options);

public sealed record TariffPart(TimeClassification Classification, decimal Hours, decimal BilledHours, decimal? Rate, Guid? HourBankId);

/// <summary>
/// Turns one time entry into what is billed (BR-TIM-03): not billable, covered by the SLA, taken from an hour bank, or billed by the
/// rate — in that order, splitting the entry when an hour bank only covers part of it.
/// </summary>
public static class TariffEngine
{
    public static IReadOnlyList<TariffPart> Classify(TariffInput input, TariffContext context)
    {
        var hours = decimal.Round(input.Hours, 2);
        if (hours <= 0)
        {
            return [];
        }

        if (!input.Billable)
        {
            return [new TariffPart(TimeClassification.NonBillable, hours, 0, null, null)];
        }

        var parts = new List<TariffPart>();
        var left = hours;

        if (context.Contract is { } contract && contract.IncludedHoursPerMonth > 0 && CoversWorkType(contract, input.WorkType))
        {
            var available = Math.Max(0, contract.IncludedHoursPerMonth - context.CoveredHoursUsedThisMonth);
            var covered = Math.Min(left, available);
            if (covered > 0)
            {
                parts.Add(new TariffPart(TimeClassification.Covered, covered, 0, null, null));
                left -= covered;
            }
        }

        decimal? bankOverageRate = null;
        foreach (var bank in context.HourBanks)
        {
            if (left <= 0)
            {
                break;
            }

            bankOverageRate ??= bank.OverageRate;
            var fromBank = Math.Min(left, bank.RemainingHours);
            if (fromBank > 0)
            {
                parts.Add(new TariffPart(TimeClassification.HourBank, fromBank, fromBank, null, bank.Id));
                left -= fromBank;
            }
        }

        if (left > 0)
        {
            var rate = bankOverageRate ?? context.ContractRate ?? context.Contract?.SlaOverageRate ?? context.CatalogRate;
            if (input.AfterHours && rate is { } baseRate)
            {
                var multiplier = context.Contract?.AfterHoursMultiplier is { } m and > 1 ? m : context.Options.DefaultAfterHoursMultiplier;
                rate = decimal.Round(baseRate * multiplier, 2);
            }

            parts.Add(new TariffPart(TimeClassification.Rate, left, BilledHours(left, input.Onsite, parts, context.Options), rate, null));
        }

        return parts;
    }

    /// <summary>True when the work started outside the SLA's support hours or on a Norwegian public holiday (BR-TIM-06).</summary>
    public static bool IsAfterHours(DateTimeOffset startedAtLocal, SupportHours coverage) =>
        BusinessTime.IsOutsideHours(startedAtLocal, coverage switch
        {
            SupportHours.Always24x7 => SupportWindow.Around,
            SupportHours.Extended12x5 => SupportWindow.Between(7, 19),
            _ => SupportWindow.Between(8, 16),
        });

    private static bool CoversWorkType(ContractBillingTerms contract, string? workType) =>
        contract.CoveredWorkTypes.Count == 0 ||
        (workType is not null && contract.CoveredWorkTypes.Contains(workType, StringComparer.OrdinalIgnoreCase));

    private static decimal BilledHours(decimal hours, bool onsite, List<TariffPart> earlierParts, TimeTrackingOptions options)
    {
        var step = Math.Clamp(options.RateRoundingMinutes, 1, 60) / 60m;
        var billed = Math.Ceiling(hours / step) * step;
        // The minimum call-out applies to the visit, so hours already covered or taken from a bank count towards it.
        if (onsite && earlierParts.Count == 0 && billed < options.MinimumOnsiteHours)
        {
            billed = options.MinimumOnsiteHours;
        }

        return decimal.Round(billed, 2);
    }
}
