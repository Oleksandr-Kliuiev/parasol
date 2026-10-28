using Crm.Backup.Features;
using Crm.Service.Features.Search;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

/// <summary>
/// Global search over the operations records: a word may name the record's customer but never lists that customer's records alone,
/// a device hit says where a word was found, a number alone is a ticket number, and a backup hit keeps its id. Synthetic data only.
/// </summary>
public sealed class GlobalSearchTests
{
    private static readonly Guid Fjord = Guid.Parse("0199f1a0-0000-7000-8000-000000000001");
    private static readonly Guid Havbris = Guid.Parse("0199f1a0-0000-7000-8000-000000000002");

    /// <summary>A record with its own name and the customer it belongs to.</summary>
    private sealed record Row(string Name, Guid OrganizationId);

    private static readonly Row[] Rows =
    [
        new("dc01", Fjord), new("fs01", Fjord), new("dc01", Havbris), new("fjord-gw", Havbris),
    ];

    private static List<Row> Find(string input, IReadOnlyDictionary<string, IReadOnlyCollection<Guid>> customers) =>
        Rows.AsQueryable()
            .WhereWords(SearchTerm.Parse(input)!, customers, word => r => r.Name.Contains(word), ids => r => ids.Contains(r.OrganizationId))
            .ToList();

    private static readonly Dictionary<string, IReadOnlyCollection<Guid>> FjordNamed = new() { ["fjord"] = [Fjord] };

    [Fact]
    public void A_word_naming_a_customer_narrows_the_records_of_another_word()
    {
        Find("dc01 fjord", FjordNamed).ShouldBe([new Row("dc01", Fjord)]);
        Find("fjord dc01", FjordNamed).ShouldBe([new Row("dc01", Fjord)]);
        Find("dc01", FjordNamed).Count.ShouldBe(2, "without the customer's name both DC01s are found");
    }

    [Fact]
    public void A_customer_name_alone_finds_only_records_whose_own_fields_hold_it()
    {
        Find("fjord", FjordNamed).ShouldBe([new Row("fjord-gw", Havbris)], "Fjord's own DC01 and FS01 are not listed for its name alone");
    }

    [Fact]
    public void A_word_naming_no_customer_must_be_found_in_the_record()
    {
        Find("dc01 nordlys", FjordNamed).ShouldBeEmpty();
        Find("dc01 fjord", new Dictionary<string, IReadOnlyCollection<Guid>>()).ShouldBeEmpty("no customer is named, and no record holds both words");
    }

    [Fact]
    public void A_device_hit_says_where_a_word_its_name_does_not_show_was_found()
    {
        DeviceKeys[] agents =
        [
            new("PC-07", "5CG1234ABC", "VARDE\\kari.nordmann", "VARDE\\ola, VARDE\\kari.nordmann"),
            new("ACCOUNTS-7", "MXL998877", null, null),
        ];

        DeviceMatch.Find(SearchTerm.Parse("pc-07")!, "PC-07", agents).ShouldBeNull("the name says it");
        DeviceMatch.Find(SearchTerm.Parse("5cg1234")!, "PC-07", agents).ShouldBe(("serial", "5CG1234ABC"));
        DeviceMatch.Find(SearchTerm.Parse("mxl99")!, "PC-07", agents).ShouldBe(("serial", "MXL998877"));
        DeviceMatch.Find(SearchTerm.Parse("kari")!, "PC-07", agents).ShouldBe(("loggedIn", "VARDE\\kari.nordmann"), "logged in at the read before last login");
        DeviceMatch.Find(SearchTerm.Parse("ola")!, "PC-07", agents).ShouldBe(("loggedIn", "VARDE\\ola"), "one user of the list, not the list");
        DeviceMatch.Find(SearchTerm.Parse("per")!, "PC-07", [new("PC-07", null, "VARDE\\per.hansen", null)]).ShouldBe(("lastLogin", "VARDE\\per.hansen"));
        DeviceMatch.Find(SearchTerm.Parse("accounts")!, "PC-07", agents).ShouldBe(("alias", "ACCOUNTS-7"));
        DeviceMatch.Find(SearchTerm.Parse("pc-07 fjord")!, "PC-07", agents).ShouldBeNull("a word found nowhere named the customer");
    }

    [Theory]
    [InlineData("1234", 1234L)]
    [InlineData("#1234", 1234L)]
    [InlineData(" 77 ", 77L)]
    [InlineData("12 34", null)]
    [InlineData("#0", null)]
    [InlineData("printer", null)]
    [InlineData("-12", null)]
    public void A_number_alone_is_a_ticket_number(string input, long? expected) =>
        TicketSearchProvider.Number(SearchTerm.Parse(input)!).ShouldBe(expected);

    [Fact]
    public void A_backup_hit_keeps_its_id_for_the_customer_and_name()
    {
        var id = BackupSearchProvider.KeyOf(Fjord, "kari@fjord.example");
        BackupSearchProvider.KeyOf(Fjord, "Kari@Fjord.example").ShouldBe(id, "the address is the same whatever its case");
        BackupSearchProvider.KeyOf(Havbris, "kari@fjord.example").ShouldNotBe(id);
        BackupSearchProvider.KeyOf(Fjord, "ola@fjord.example").ShouldNotBe(id);
    }
}
