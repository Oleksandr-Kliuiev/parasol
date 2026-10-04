using Crm.Reports;

namespace Crm.UnitTests;

/// <summary>DEV-14: the rules of the BI datasets that need no host — ordering, cursors, provenance and the vocabulary of the numbers.</summary>
public class BiMartTests
{
    [Fact]
    public void A_snapshot_is_Captured_within_the_grace_after_the_month_and_Reconstructed_after()
    {
        var last = new DateOnly(2026, 9, 30);
        BiSnapshotService.ProvenanceOf(new DateOnly(2026, 10, 1), last, 5).ShouldBe("Captured");
        BiSnapshotService.ProvenanceOf(new DateOnly(2026, 10, 5), last, 5).ShouldBe("Captured");
        BiSnapshotService.ProvenanceOf(new DateOnly(2026, 10, 6), last, 5).ShouldBe("Reconstructed");
    }

    [Fact]
    public void Months_are_read_strictly_as_yyyy_MM()
    {
        BiSnapshotService.MonthOf("2026-09").ShouldBe(new DateOnly(2026, 9, 1));
        foreach (var bad in new[] { "2026-9", "2026-13", "september", "", "2026-09-01" })
        {
            BiSnapshotService.MonthOf(bad).ShouldBe(default, bad);
        }
    }

    [Fact]
    public void A_key_orders_whole_numbers_as_numbers_and_the_cursor_returns_exactly_what_it_was_given()
    {
        var months = BiService.Find("revenue-by-month")!;
        string Key(int year, int month) => BiService.KeyOf(months, [year, month, 0m, 0m]);
        string.CompareOrdinal(Key(2026, 9), Key(2026, 10)).ShouldBeLessThan(0, "9 comes before 10");
        string.CompareOrdinal(Key(2025, 12), Key(2026, 1)).ShouldBeLessThan(0);

        var asOf = new DateTimeOffset(2026, 10, 4, 8, 30, 0, TimeSpan.Zero);
        var cursor = BiCursor.Encode(asOf, new DateOnly(2026, 1, 1), new DateOnly(2026, 9, 30), Key(2026, 9));
        cursor.ShouldNotContain("=");
        var decoded = BiCursor.Decode(cursor)!.Value;
        (decoded.AsOf, decoded.From, decoded.To, decoded.LastKey).ShouldBe((asOf, new DateOnly(2026, 1, 1), new DateOnly(2026, 9, 30), Key(2026, 9)));
        BiCursor.Decode("garbage!").ShouldBeNull();
        BiCursor.Decode(cursor[..^3]).ShouldBeNull();
        BiCursor.Decode(null).ShouldBeNull();
    }

    [Fact]
    public void Every_dataset_has_typed_columns_a_key_and_a_definition_and_nothing_claims_a_payment()
    {
        BiService.Datasets.Select(d => d.Name).ShouldBeUnique();
        foreach (var dataset in BiService.Datasets)
        {
            dataset.Columns.Select(c => c.Name).ShouldBeUnique(dataset.Name);
            string[] types = ["guid", "string", "int", "decimal", "date", "bool"];
            dataset.Columns.Select(c => c.Type).ShouldBeSubsetOf(types, dataset.Name);
            dataset.KeyColumns.ShouldBeInRange(1, dataset.Columns.Count);
            dataset.Definition.ShouldNotBeNullOrWhiteSpace();
            dataset.Columns.ShouldNotContain(c => c.Name.Contains("paid", StringComparison.OrdinalIgnoreCase), dataset.Name);
        }

        // Cost data needs the cost grant and nothing else does.
        BiService.Datasets.Where(d => d.RequiresCost).Select(d => d.Name).ShouldBe(["microsoft-costs", "margins"], ignoreOrder: true);
        BiService.Glossary.Keys.ShouldContain("outstanding");
        BiService.Glossary["MRR"].ShouldContain("Not revenue billed");
    }
}
