using Crm.TimeTracking.Persistence;

namespace Crm.UnitTests;

public sealed class TimeMonthAdmissionTests
{
    [Fact]
    public void Months_are_global_invariant_distinct_and_sorted_numerically_before_any_entry_lock()
    {
        var months = MonthAdmission.Ordered([new(2092, 2), new(2091, 11), new(2092, 1), new(2092, 2)]);
        months.Select(m => m.Resource).ShouldBe(["time:period:2091-11", "time:period:2092-01", "time:period:2092-02"]);
        new TimeMonth(1, 1).Resource.ShouldBe("time:period:0001-01");
        TimeMonth.Of(new(2092, 2, 29)).ShouldBe(new(2092, 2));
        new TimeMonth(2092, 2).Start.ShouldBe(new(2092, 2, 1));
        new TimeMonth(2092, 2).End.ShouldBe(new(2092, 2, 29));
        new TimeMonth(9999, 12).End.ShouldBe(DateOnly.MaxValue);
    }
    [Fact]
    public void A_default_struct_cannot_bypass_month_validation() =>
        Should.Throw<ArgumentOutOfRangeException>(() => MonthAdmission.Ordered([default]));

    [Theory]
    [InlineData(0, 1)] [InlineData(10000, 1)] [InlineData(2090, 0)] [InlineData(2090, 13)]
    public void Invalid_months_cannot_become_admission_resources(int year, int month) =>
        Should.Throw<ArgumentOutOfRangeException>(() => new TimeMonth(year, month));
}
