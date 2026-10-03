using System.Data.SqlTypes;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;

namespace Crm.UnitTests;

public class SequentialIdTests
{
    [Fact]
    public void Ids_are_ascending_in_sql_server_uniqueidentifier_order()
    {
        var start = DateTimeOffset.UtcNow;
        var ids = Enumerable.Range(0, 2000).Select(i => SequentialId.New(start.AddMilliseconds(i / 10))).ToList();

        for (int i = 1; i < ids.Count; i++)
        {
            new SqlGuid(ids[i]).CompareTo(new SqlGuid(ids[i - 1])).ShouldBeGreaterThan(0, $"id #{i} is not after #{i - 1}");
        }
    }

    [Fact]
    public void Ids_are_unique()
    {
        var ids = Enumerable.Range(0, 10_000).Select(_ => SequentialId.New()).ToHashSet();
        ids.Count.ShouldBe(10_000);
    }
}

public class KeysetCursorTests
{
    [Fact]
    public void Cursor_round_trips()
    {
        var cursor = new KeysetCursor("Ålesund Data AS", Guid.NewGuid());
        KeysetCursor.Decode(cursor.Encode()).ShouldBe(cursor);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not-a-cursor!!")]
    [InlineData("e30")]
    public void Invalid_cursor_decodes_to_null_or_empty(string? value)
    {
        var decoded = KeysetCursor.Decode(value);
        (decoded is null || decoded.SortKey is null).ShouldBeTrue();
    }

    [Theory]
    [InlineData(null, 50)]
    [InlineData(0, 1)]
    [InlineData(10, 10)]
    [InlineData(5000, 200)]
    public void Limit_is_clamped(int? requested, int expected) => KeysetCursor.ClampLimit(requested).ShouldBe(expected);
}

public class SearchTermTests
{
    [Fact]
    public void Parses_words_and_digits()
    {
        var term = SearchTerm.Parse("  Fjord  IT ")!;
        term.Text.ShouldBe("Fjord  IT");
        term.Words.ShouldBe(["fjord", "it"]);
        term.IsNumeric.ShouldBeFalse();
    }

    [Theory]
    [InlineData("923 609 016", "923609016")]
    [InlineData("+47 22 00 00 00", "4722000000")]
    public void Numeric_input_is_recognized(string input, string digits)
    {
        var term = SearchTerm.Parse(input)!;
        term.IsNumeric.ShouldBeTrue();
        term.Digits.ShouldBe(digits);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" a ")]
    public void Too_short_input_is_rejected(string? input) => SearchTerm.Parse(input).ShouldBeNull();
}
