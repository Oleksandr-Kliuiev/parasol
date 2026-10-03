namespace Crm.SharedKernel.Time;

/// <summary>
/// Norwegian public holidays (BR-SRV-05). The movable ones follow Easter, so they are computed, not listed; the fixed ones
/// are the ones the law names. Days off that are not public holidays (Christmas Eve, New Year's Eve) are left out —
/// a support agreement names those separately when they matter.
/// </summary>
public static class NorwegianHolidays
{
    public static bool IsHoliday(DateOnly date)
    {
        if (date is { Month: 1, Day: 1 } or { Month: 5, Day: 1 } or { Month: 5, Day: 17 }
            or { Month: 12, Day: 25 } or { Month: 12, Day: 26 })
        {
            return true;
        }

        var easter = EasterSunday(date.Year);
        // Maundy Thursday, Good Friday, Easter Sunday and Monday, Ascension, Whit Sunday and Monday.
        int[] offsets = [-3, -2, 0, 1, 39, 49, 50];
        return Array.Exists(offsets, offset => easter.AddDays(offset) == date);
    }

    /// <summary>A day nobody is expected to work: weekend or public holiday.</summary>
    public static bool IsNonWorkingDay(DateOnly date) =>
        date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday || IsHoliday(date);

    /// <summary>Anonymous Gregorian algorithm; Norway follows the Western date.</summary>
    public static DateOnly EasterSunday(int year)
    {
        var a = year % 19;
        var b = year / 100;
        var c = year % 100;
        var d = b / 4;
        var e = b % 4;
        var f = (b + 8) / 25;
        var g = (b - f + 1) / 3;
        var h = ((19 * a) + b - d - g + 15) % 30;
        var i = c / 4;
        var k = c % 4;
        var l = (32 + (2 * e) + (2 * i) - h - k) % 7;
        var m = (a + (11 * h) + (22 * l)) / 451;
        var month = (h + l - (7 * m) + 114) / 31;
        var day = ((h + l - (7 * m) + 114) % 31) + 1;
        return new DateOnly(year, month, day);
    }
}
