using Crm.SharedKernel.Text;
using Shouldly;

namespace Crm.UnitTests;

public sealed class WarningListTests
{
    [Fact]
    public void A_short_list_is_returned_whole()
    {
        WarningList.Capped(["a", "b"]).ShouldBe(["a", "b"]);
        WarningList.Capped(Enumerable.Range(0, 20).Select(i => $"w{i}")).Count.ShouldBe(20);
    }

    [Fact]
    public void A_long_list_ends_with_how_many_more_there_were()
    {
        var capped = WarningList.Capped(Enumerable.Range(0, 500).Select(i => $"Row {i}: the price is not a number."));
        capped.Count.ShouldBe(20);
        capped[18].ShouldBe("Row 18: the price is not a number.");
        capped[19].ShouldBe("…and 481 more.");
    }
}
