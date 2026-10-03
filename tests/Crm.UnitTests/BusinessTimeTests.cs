using Crm.SharedKernel.Time;

namespace Crm.UnitTests;

public class NorwegianHolidayTests
{
    [Theory]
    [InlineData(2026, 4, 5)]
    [InlineData(2027, 3, 28)]
    [InlineData(2028, 4, 16)]
    public void Easter_follows_the_western_date(int year, int month, int day) =>
        NorwegianHolidays.EasterSunday(year).ShouldBe(new DateOnly(year, month, day));

    [Fact]
    public void The_fixed_and_the_movable_holidays_are_both_days_off()
    {
        // 2026: Easter Sunday 05.04 — Maundy Thursday 02.04, Good Friday 03.04, Easter Monday 06.04, Ascension 14.05, Whit Monday 25.05.
        foreach (var date in new[]
                 {
                     new DateOnly(2026, 1, 1), new DateOnly(2026, 4, 2), new DateOnly(2026, 4, 3), new DateOnly(2026, 4, 6),
                     new DateOnly(2026, 5, 1), new DateOnly(2026, 5, 14), new DateOnly(2026, 5, 17), new DateOnly(2026, 5, 25),
                     new DateOnly(2026, 12, 25), new DateOnly(2026, 12, 26),
                 })
        {
            NorwegianHolidays.IsHoliday(date).ShouldBeTrue($"{date:yyyy-MM-dd} is a public holiday");
        }

        // Christmas Eve is a short day in practice but not a public holiday, so the SLA clock still runs.
        NorwegianHolidays.IsHoliday(new DateOnly(2026, 12, 24)).ShouldBeFalse();
        NorwegianHolidays.IsNonWorkingDay(new DateOnly(2026, 9, 26)).ShouldBeTrue(); // Saturday
        NorwegianHolidays.IsNonWorkingDay(new DateOnly(2026, 9, 25)).ShouldBeFalse();
    }
}

public class BusinessTimeTests
{
    private static readonly SupportWindow Office = SupportWindow.Between(8, 16);

    private static DateTimeOffset At(int year, int month, int day, int hour, int minute = 0) =>
        new(new DateTime(year, month, day, hour, minute, 0), TimeSpan.Zero);

    [Fact]
    public void Inside_the_window_the_clock_runs_as_usual()
    {
        // Wednesday 09:00 → 11:30.
        BusinessTime.MinutesBetween(At(2026, 9, 23, 9), At(2026, 9, 23, 11, 30), Office).ShouldBe(150);
    }

    [Fact]
    public void Time_outside_the_window_does_not_count()
    {
        // Raised 17:00 Wednesday, answered 09:00 Thursday: only the hour after opening counts.
        BusinessTime.MinutesBetween(At(2026, 9, 23, 17), At(2026, 9, 24, 9), Office).ShouldBe(60);
    }

    [Fact]
    public void A_weekend_ticket_starts_its_clock_on_monday()
    {
        // Friday 18:00 → Monday 08:30 under 8×5 is half an hour of support time.
        BusinessTime.MinutesBetween(At(2026, 9, 25, 18), At(2026, 9, 28, 8, 30), Office).ShouldBe(30);
    }

    [Fact]
    public void Public_holidays_are_skipped()
    {
        // 17. mai 2027 is a Monday: Friday 15:00 → Tuesday 09:00 counts one hour on Friday plus one on Tuesday.
        BusinessTime.MinutesBetween(At(2027, 5, 14, 15), At(2027, 5, 18, 9), Office).ShouldBe(120);
    }

    [Fact]
    public void Around_the_clock_coverage_counts_every_minute()
    {
        // Friday 18:00 → Monday 08:30 is 62,5 hours.
        BusinessTime.MinutesBetween(At(2026, 9, 25, 18), At(2026, 9, 28, 8, 30), SupportWindow.Around).ShouldBe(3750);
        BusinessTime.IsOutsideHours(At(2026, 9, 26, 3), SupportWindow.Around).ShouldBeFalse();
    }

    [Fact]
    public void Outside_hours_covers_evenings_weekends_and_holidays()
    {
        BusinessTime.IsOutsideHours(At(2026, 9, 23, 7), Office).ShouldBeTrue();
        BusinessTime.IsOutsideHours(At(2026, 9, 23, 16), Office).ShouldBeTrue();
        BusinessTime.IsOutsideHours(At(2026, 9, 23, 15, 59), Office).ShouldBeFalse();
        BusinessTime.IsOutsideHours(At(2026, 5, 17, 10), Office).ShouldBeTrue();
    }
}
