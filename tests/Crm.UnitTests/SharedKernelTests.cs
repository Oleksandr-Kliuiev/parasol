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

/// <summary>Text from a person in a log line, in a spreadsheet cell and in a CSV record (F-G5-10, F-G1-10).</summary>
public class TextSafetyTests
{
    [Fact]
    public void A_line_break_cannot_start_a_forged_log_line()
    {
        Crm.SharedKernel.Text.LogText.Clean("planned work\r\nfail: Crm.Security[0]\n      admin signed in\u2028x\u2029y\0z")
            .ShouldBe("planned work  fail: Crm.Security[0]       admin signed in x y z");
        Crm.SharedKernel.Text.LogText.Clean("plain").ShouldBe("plain");
        Crm.SharedKernel.Text.LogText.Clean(null).ShouldBeNull();
    }

    [Theory]
    [InlineData("=HYPERLINK(\"http://evil\",\"x\")", "\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\"")]
    [InlineData("+1+1", "'+1+1")]
    [InlineData("-2+3", "'-2+3")]
    [InlineData("@SUM(A1)", "'@SUM(A1)")]
    [InlineData("\t=1", "'\t=1")]
    [InlineData("\r=1", "\"'\r=1\"")]
    [InlineData("Kari Nordmann", "Kari Nordmann")]
    [InlineData("a;b", "\"a;b\"")]
    [InlineData("two\nlines", "\"two\nlines\"")]
    [InlineData("say \"hi\"", "\"say \"\"hi\"\"\"")]
    [InlineData("", "")]
    public void A_csv_cell_is_neutralized_and_quoted(string value, string expected) =>
        Crm.SharedKernel.Text.CsvCell.Write(value).ShouldBe(expected);
}
