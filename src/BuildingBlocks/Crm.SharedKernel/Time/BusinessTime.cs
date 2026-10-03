namespace Crm.SharedKernel.Time;

/// <summary>Opening hours of a support agreement: a window on working days, or around the clock.</summary>
public readonly record struct SupportWindow(int FromHour, int ToHour, bool AlwaysOpen)
{
    public static SupportWindow Around => new(0, 24, true);

    public static SupportWindow Between(int fromHour, int toHour) => new(fromHour, toHour, false);

    public int MinutesPerDay => AlwaysOpen ? 24 * 60 : Math.Max(0, (ToHour - FromHour) * 60);
}

/// <summary>
/// Counts the time an SLA clock actually runs (BR-SRV-05): only inside the agreement's support hours, and never on a
/// weekend or a Norwegian public holiday. A ticket raised on Friday evening under 8×5 starts its clock Monday morning.
/// </summary>
public static class BusinessTime
{
    /// <summary>Minutes of support time between two moments, both given in Oslo local time.</summary>
    public static int MinutesBetween(DateTimeOffset from, DateTimeOffset to, SupportWindow window)
    {
        if (to <= from)
        {
            return 0;
        }

        if (window.AlwaysOpen)
        {
            return (int)Math.Round((to - from).TotalMinutes, MidpointRounding.AwayFromZero);
        }

        var minutes = 0d;
        var day = DateOnly.FromDateTime(from.DateTime);
        var last = DateOnly.FromDateTime(to.DateTime);
        // A year of open tickets is the sensible ceiling; anything longer is a data problem, not an SLA measurement.
        for (var guard = 0; day <= last && guard < 400; guard++, day = day.AddDays(1))
        {
            if (NorwegianHolidays.IsNonWorkingDay(day))
            {
                continue;
            }

            var open = new DateTimeOffset(day.ToDateTime(new TimeOnly(window.FromHour, 0)), from.Offset);
            var close = new DateTimeOffset(day.ToDateTime(new TimeOnly(0, 0)).AddHours(window.ToHour), from.Offset);
            var start = from > open ? from : open;
            var end = to < close ? to : close;
            if (end > start)
            {
                minutes += (end - start).TotalMinutes;
            }
        }

        return (int)Math.Round(minutes, MidpointRounding.AwayFromZero);
    }

    /// <summary>True when the moment falls outside the support window (BR-TIM-06).</summary>
    public static bool IsOutsideHours(DateTimeOffset moment, SupportWindow window) =>
        !window.AlwaysOpen &&
        (NorwegianHolidays.IsNonWorkingDay(DateOnly.FromDateTime(moment.DateTime)) ||
         moment.Hour < window.FromHour || moment.Hour >= window.ToHour);
}
