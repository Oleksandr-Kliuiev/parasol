using Crm.Contracts.Contracts;

namespace Crm.Billing.Domain;

/// <summary>The period a recurring contract line is invoiced for in a given run.</summary>
public sealed record CoveredPeriod(DateOnly From, DateOnly To)
{
    public int Days => To.DayNumber - From.DayNumber + 1;
}

/// <summary>
/// The part of a covered period a line is actually in force for (FR-BIL-05). <see cref="Factor"/> is 1 for a full period;
/// anything less is charged proportionally by days, which is also what a mid-period change produces — the old version of
/// the line ends and the new one starts, and each is billed for its own days.
/// </summary>
public sealed record Proration(DateOnly From, DateOnly To, decimal Factor)
{
    public bool IsPartial => Factor < 1m;
}

/// <summary>
/// Decides whether a recurring contract line falls due in a run and which months the invoice covers. Quarterly and yearly
/// contracts are billed on the anniversary of their start month, in advance for the coming term or in arrears for the past one.
/// Usage (hours, hour-bank purchases) is always billed for the run's own period.
/// </summary>
public static class BillingSchedule
{
    public static int MonthsOf(InvoiceFrequency frequency) => frequency switch
    {
        InvoiceFrequency.Monthly => 1,
        InvoiceFrequency.Quarterly => 3,
        InvoiceFrequency.Yearly => 12,
        _ => 1,
    };

    /// <summary>Null when the line is not invoiced in this run.</summary>
    public static CoveredPeriod? Covers(
        DateOnly contractStart, InvoiceFrequency frequency, InvoiceTiming timing, DateOnly periodStart, DateOnly lineValidFrom, DateOnly? lineValidTo)
    {
        var months = MonthsOf(frequency);
        var elapsed = ((periodStart.Year - contractStart.Year) * 12) + periodStart.Month - contractStart.Month;
        if (elapsed < 0 || elapsed % months != 0)
        {
            return null;
        }

        var firstOfMonth = new DateOnly(periodStart.Year, periodStart.Month, 1);
        var covered = timing == InvoiceTiming.InAdvance
            ? new CoveredPeriod(firstOfMonth, firstOfMonth.AddMonths(months).AddDays(-1))
            : new CoveredPeriod(firstOfMonth.AddMonths(-months), firstOfMonth.AddDays(-1));

        // In arrears the first invoice comes after the first term, and nothing before the contract started is billed.
        if (timing == InvoiceTiming.InArrears && (elapsed == 0 || covered.From < new DateOnly(contractStart.Year, contractStart.Month, 1)))
        {
            return null;
        }

        return lineValidFrom <= covered.To && (lineValidTo is null || lineValidTo >= covered.From) ? covered : null;
    }

    /// <summary>How much of the covered period the line is in force for, by days (BR-BIL-11).</summary>
    public static Proration Prorate(CoveredPeriod covered, DateOnly lineValidFrom, DateOnly? lineValidTo)
    {
        var from = lineValidFrom > covered.From ? lineValidFrom : covered.From;
        var to = lineValidTo is { } end && end < covered.To ? end : covered.To;
        if (to < from)
        {
            return new Proration(covered.From, covered.To, 0m);
        }

        var days = to.DayNumber - from.DayNumber + 1;
        return days >= covered.Days
            ? new Proration(covered.From, covered.To, 1m)
            : new Proration(from, to, decimal.Round((decimal)days / covered.Days, 4));
    }
}
