using System.Reflection;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.Customers.Features.Organizations;
using Crm.SharedKernel.Text;

namespace Crm.UnitTests;

/// <summary>DEV-20: the reader of the files partners and old systems send. Synthetic data only.</summary>
public sealed class CsvTableHardeningTests
{
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["name"] = "name",
        ["note"] = "note",
        ["date"] = "date",
    };

    [Fact]
    public void A_quoted_value_may_hold_line_breaks_the_delimiter_and_doubled_quotes()
    {
        var table = CsvTable.Parse("name;note\r\n\"Fjord; IT\";\"first line\r\nsecond \"\"quoted\"\" line\"\r\nNext;plain\r\n", Aliases)!;
        table.RowCount.ShouldBe(2);
        table.Value(0, "name").ShouldBe("Fjord; IT");
        table.Value(0, "note").ShouldBe("first line\nsecond \"quoted\" line");
        table.Value(1, "name").ShouldBe("Next");
        table.Line(0).ShouldBe(2);
        table.Line(1).ShouldBe(4, "the quoted value spans two lines, so the next row starts two lines further down");
    }

    [Fact]
    public void Blank_lines_are_skipped_but_still_counted_in_the_reported_line_numbers()
    {
        var table = CsvTable.Parse("name;note\n\nA;1\n   \n\nB;2\n", Aliases)!;
        table.RowCount.ShouldBe(2);
        table.Line(0).ShouldBe(3);
        table.Line(1).ShouldBe(6);
    }

    [Fact]
    public void Quotes_that_belong_to_the_text_are_kept_and_a_BOM_is_ignored()
    {
        var table = CsvTable.Parse("﻿name;note\n5\" rack;He said \"hi\"\n\"\"\"Quoted\"\" AS\";x\n", Aliases)!;
        table.Value(0, "name").ShouldBe("5\" rack");
        table.Value(0, "note").ShouldBe("He said \"hi\"");
        table.Value(1, "name").ShouldBe("\"Quoted\" AS");
    }

    [Fact]
    public void Ragged_rows_are_reported_by_the_line_they_start_on()
    {
        var table = CsvTable.Parse("name;note;date\nshort;x\nlong;x;2026-01-01;surplus\nfine;x;2026-01-01;\nfine;x;2026-01-01\n", Aliases)!;
        table.RowIssues(0).ShouldBe([CsvTable.RaggedShort]);
        table.RowIssues(1).ShouldBe([CsvTable.RaggedExtra]);
        table.RowIssues(2).ShouldBeEmpty("an empty surplus cell is a trailing delimiter, not shifted columns");
        table.RowIssues(3).ShouldBeEmpty();
        table.Issues.Select(i => (i.Line, i.Code)).ShouldBe([(2, CsvTable.RaggedShort), (3, CsvTable.RaggedExtra)]);
    }

    [Fact]
    public void An_unterminated_quote_is_flagged_instead_of_swallowing_the_file_silently()
    {
        var table = CsvTable.Parse("name;note\nA;\"never closed\nB;2\n", Aliases)!;
        table.RowCount.ShouldBe(1);
        table.RowIssues(0).ShouldContain(CsvTable.UnterminatedQuote);
    }

    [Theory]
    [InlineData("2026-03-15", 2026, 3, 15)]
    [InlineData("2026-03-15T10:00:00Z", 2026, 3, 15)]
    [InlineData("15.03.2026", 2026, 3, 15)]
    [InlineData("3.4.2026", 2026, 4, 3)]
    [InlineData("15/03/2026", 2026, 3, 15)]
    [InlineData("03/25/2026", 2026, 3, 25)]
    [InlineData("05/05/2026", 2026, 5, 5)]
    public void Dates_with_one_possible_reading_are_read(string text, int year, int month, int day)
    {
        CsvTable.Date(text, out var ambiguous).ShouldBe(new DateOnly(year, month, day));
        ambiguous.ShouldBeFalse();
    }

    [Theory]
    [InlineData("03/04/2026")]
    [InlineData("1/2/2026")]
    public void A_slash_date_that_reads_two_ways_is_not_guessed(string text)
    {
        CsvTable.Date(text, out var ambiguous).ShouldBeNull();
        ambiguous.ShouldBeTrue();
        CsvTable.Date(text).ShouldBeNull();
    }

    [Theory]
    [InlineData("March the first")]
    [InlineData("31.02.2026")]
    [InlineData("")]
    public void Anything_else_is_not_a_date_and_not_ambiguous(string text)
    {
        CsvTable.Date(text, out var ambiguous).ShouldBeNull();
        ambiguous.ShouldBeFalse();
    }
}

public sealed class MigrationFileTests
{
    private static MigrationRowData Row(string header, string row, bool broken = false) =>
        MigrationFile.ReadRow(CsvTable.Parse($"{header}\n{row}\n", MigrationFile.Aliases)!, 0, "sha", broken);

    [Theory]
    [InlineData("https://www.Example.NO/", "www.example.no")]
    [InlineData("HTTP://example.no/side?x=1", "example.no")]
    [InlineData("@example.no", "example.no")]
    [InlineData("user@example.no", "example.no")]
    [InlineData("example.no:8080", "example.no")]
    [InlineData("sub.example.no.", "sub.example.no")]
    public void A_domain_is_stored_as_a_bare_lower_case_host(string raw, string expected) =>
        MigrationFile.NormalizeDomain(raw).ShouldBe(expected);

    [Theory]
    [InlineData("not a domain")]
    [InlineData("localhost")]
    [InlineData("-bad-.no")]
    [InlineData("a..no")]
    public void Something_that_is_no_host_name_is_refused(string raw) => MigrationFile.NormalizeDomain(raw).ShouldBeNull();

    [Theory]
    [InlineData("name;orgnr", "Fjord AS;123456789", ImportReason.InvalidOrgNumber)]
    [InlineData("name;email", "Fjord AS;not-an-address", ImportReason.InvalidEmail)]
    [InlineData("name;email", "Fjord AS;Fjord <a@b.no>", ImportReason.InvalidEmail)]
    [InlineData("name;invoiceemail", "Fjord AS;a@@b.no", ImportReason.InvalidEmail)]
    [InlineData("name;contactfirstname;contactemail", "Fjord AS;Ola;oops", ImportReason.InvalidContactEmail)]
    [InlineData("name;domain", "Fjord AS;two words", ImportReason.InvalidDomain)]
    [InlineData("name;status", "Fjord AS;bestemor", ImportReason.UnknownStatus)]
    [InlineData("name;vatrate", "Fjord AS;20", ImportReason.InvalidVatRate)]
    [InlineData("name;currency", "Fjord AS;KR", ImportReason.InvalidCurrency)]
    [InlineData("name;contractstart;contractend", "Fjord AS;2026-05-01;2026-04-30", ImportReason.ContractDatesOrder)]
    [InlineData("name;contractstart", "Fjord AS;03/04/2026", ImportReason.AmbiguousDate)]
    [InlineData("name;contractend", "Fjord AS;yesterday", ImportReason.InvalidDate)]
    [InlineData("name;parentorgnr", "Fjord AS;12345", ImportReason.InvalidParentOrgNumber)]
    [InlineData("name;externalsystem", "Fjord AS;oldcrm", ImportReason.IncompleteExternalId)]
    [InlineData("name;orgnr", ";923609016", ImportReason.MissingName)]
    [InlineData("name;note", "Fjord AS;x", null)]
    public void A_row_that_cannot_be_imported_says_why_by_a_code(string header, string row, string? expected) =>
        Row(header, row).RejectCode.ShouldBe(expected);

    [Fact]
    public void The_allowed_values_pass_and_are_normalised()
    {
        var row = Row(
            "name;orgnr;status;vatrate;currency;contractstart;contractend;parentorgnr;externalsystem;externalid;owner;contactemail;domain",
            "Fjord AS;923 609 016;kunde;25 %;nok;2026-01-01;2026-12-31;974760673;oldcrm;K-1;Eier@Example.no;Ola@Example.NO;https://Fjord.no/");
        row.RejectCode.ShouldBeNull();
        row.OrgNumber.ShouldBe("923609016");
        row.Status.ShouldBe(OrganizationStatus.Customer);
        row.VatRate.ShouldBe(25m);
        row.Currency.ShouldBe("NOK");
        row.ContractStart.ShouldBe(new DateOnly(2026, 1, 1));
        row.OwnerEmail.ShouldBe("eier@example.no");
        row.ContactEmail.ShouldBe("ola@example.no");
        row.Domain.ShouldBe("fjord.no");
        MigrationFile.ValidatedValues(row).ShouldBe(
            ["externalsystem", "externalid", "parentorgnumber", "contractstart", "contractend", "currency", "vatrate"]);
    }

    [Fact]
    public void A_value_longer_than_its_column_rejects_the_row_instead_of_failing_a_whole_chunk_later()
    {
        Row("name", new string('x', 257)).RejectCode.ShouldBe(ImportReason.FieldTooLong);
        Row("name;phone", $"Fjord AS;{new string('1', 33)}").RejectCode.ShouldBe(ImportReason.FieldTooLong);
    }

    [Fact]
    public void Bytes_that_were_not_UTF8_reject_the_rows_that_hold_them_and_only_those()
    {
        Row("name", "Fj�rd AS", broken: true).RejectCode.ShouldBe(ImportReason.EncodingInvalid);
        Row("name", "Fjord AS", broken: true).RejectCode.ShouldBeNull();
    }

    [Fact]
    public void Shifted_columns_reject_the_row_and_a_short_row_only_warns()
    {
        Row("name;phone", "Fjord AS;1;2").RejectCode.ShouldBe(ImportReason.RaggedRow);
        var shortRow = Row("name;phone;city", "Fjord AS;1");
        shortRow.RejectCode.ShouldBeNull();
        shortRow.Warnings.ShouldContain(ImportReason.RaggedRow);
    }

    [Fact]
    public void The_source_key_relates_rows_without_storing_the_number_and_differs_per_file()
    {
        var one = MigrationFile.ReadRow(CsvTable.Parse("name;orgnr\nA AS;923609016\n", MigrationFile.Aliases)!, 0, "file-one", false);
        var two = MigrationFile.ReadRow(CsvTable.Parse("name;orgnr\nB AS;923609016\n", MigrationFile.Aliases)!, 0, "file-one", false);
        var other = MigrationFile.ReadRow(CsvTable.Parse("name;orgnr\nA AS;923609016\n", MigrationFile.Aliases)!, 0, "file-two", false);
        one.SourceKey.ShouldBe(two.SourceKey);
        one.SourceKey.ShouldNotBe(other.SourceKey);
        one.SourceKey!.ShouldNotContain("923609016");
    }
}

public sealed class FillGapsTests
{
    private static OrganizationDetails Full(string tag, Guid manager) => new(
        $"Fjord {tag} AS", "923609016", "AS", OrganizationStatus.Customer, "62.010", $"https://fjord-{tag}.no", $"2200{tag.Length}000",
        $"post@fjord-{tag}.no", $"faktura@fjord-{tag}.no", true, manager, manager,
        new Address($"Postveien {tag}", "0150", "Oslo", "NO"), new Address($"Besøksveien {tag}", "0151", "Oslo", "NO"),
        new Address($"Fakturaveien {tag}", "0152", "Oslo", "NO"), [$"fjord-{tag}.no"]);

    [Fact]
    public void Nothing_a_person_typed_is_replaced_and_the_differences_are_named_without_their_values()
    {
        var typed = Organization.Create(Full("crm", Guid.NewGuid())).Value;
        typed.ClearDomainEvents();
        var before = typed.Snapshot();

        var file = Full("file", Guid.NewGuid()) with { OrgNumber = "974760673", Status = OrganizationStatus.Lead };
        typed.FillGaps(file).ShouldBeEmpty();
        typed.Snapshot().ShouldBe(before);
        typed.DomainEvents.ShouldBeEmpty("no change, no OrganizationUpdated");
        typed.FindConflicts(file, compareStatus: true).ShouldBe(
            ["name", "orgNumber", "status", "website", "phone", "email", "accountManager", "primaryTechnician", "postalAddress", "visitAddress",
                "domains", "invoiceEmail", "billingAddress"], ignoreOrder: true);
    }

    [Fact]
    public void Only_the_gaps_are_filled_and_the_event_is_raised_once_with_the_names()
    {
        var manager = Guid.NewGuid();
        var sparse = Organization.Create(new OrganizationDetails("Fjord AS", null, null, OrganizationStatus.Customer, null, null, "22000000", null, null, false,
            null, null, null, null, null, null)).Value;
        sparse.ClearDomainEvents();

        var filled = sparse.FillGaps(Full("file", manager) with { Phone = "99999999" });
        filled.ShouldBe(
            ["orgNumber", "legalForm", "naceCode", "website", "email", "accountManager", "primaryTechnician", "postalAddress", "visitAddress", "domains",
                "invoiceEmail", "ehfEnabled", "billingAddress"], ignoreOrder: true);
        sparse.Phone.ShouldBe("22000000", "the phone number the CRM had stays");
        sparse.Name.ShouldBe("Fjord AS");
        sparse.DomainEvents.OfType<OrganizationUpdated>().ShouldHaveSingleItem();
        sparse.RegistryStatus.ShouldBe(BrregStatus.Unknown, "a new number must be checked against the registry");

        sparse.ClearDomainEvents();
        sparse.FillGaps(Full("file", manager)).ShouldBeEmpty("a repeat finds nothing to fill");
        sparse.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void Billing_fields_owned_by_another_system_are_left_alone()
    {
        var sparse = Organization.Create(new OrganizationDetails("Fjord AS", null, null, OrganizationStatus.Customer, null, null, null, null, null, false,
            null, null, null, null, null, null)).Value;
        var filled = sparse.FillGaps(Full("file", Guid.NewGuid()), includeBilling: false);
        filled.ShouldNotContain("invoiceEmail");
        filled.ShouldNotContain("ehfEnabled");
        filled.ShouldNotContain("billingAddress");
        sparse.InvoiceEmail.ShouldBeNull();
        sparse.FindConflicts(Full("other", Guid.NewGuid()), includeBilling: false).ShouldNotContain("invoiceEmail");
    }

    [Fact]
    public void Spelling_that_means_the_same_is_no_conflict()
    {
        var organization = Organization.Create(new OrganizationDetails("Fjord IT AS", null, null, OrganizationStatus.Customer, null, "https://www.fjord.no/", "+47 22 00 00 00",
            "post@fjord.no", null, false, null, null, new Address("Storgata 1", "0155", "Oslo", "NO"), null, null, ["fjord.no"])).Value;
        var file = new OrganizationDetails("FJORD IT", null, null, OrganizationStatus.Customer, null, "fjord.no", "22000000", "POST@fjord.no", null, false, null, null,
            new Address("storgata 1", "0155", "OSLO", "NO"), null, null, ["fjord.no"]);
        organization.FindConflicts(file).ShouldBeEmpty();
        organization.FillGaps(file).ShouldBeEmpty();
    }

    [Fact]
    public void A_contact_keeps_its_name_phone_and_language_and_is_filled_where_empty()
    {
        var contact = Contact.Create(new ContactDetails("Ola", "Nordmann", null, "40000000", null, "nb")).Value;
        contact.ClearDomainEvents();

        var file = new ContactDetails("Kari", string.Empty, "ola@example.no", null, "90000000", "en");
        contact.FindConflicts(file).ShouldBe(["firstName"]);
        contact.FillGaps(file).ShouldBe(["email", "mobilePhone"], ignoreOrder: true);
        (contact.FirstName, contact.LastName, contact.Phone, contact.PreferredLanguage).ShouldBe(("Ola", "Nordmann", "40000000", "nb"));
        contact.DomainEvents.OfType<ContactUpdated>().ShouldHaveSingleItem();

        contact.ClearDomainEvents();
        contact.FillGaps(file).ShouldBeEmpty();
        contact.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void An_affiliation_is_filled_never_revived_and_roles_that_differ_are_a_conflict()
    {
        var organizationId = Guid.NewGuid();
        var contact = Contact.Create(new ContactDetails("Ola", "Nordmann", "ola@example.no", null, null, null)).Value;
        contact.StateFor(organizationId).ShouldBe(AffiliationState.None);
        contact.Affiliate(organizationId, new AffiliationDetails(null, ContactRoles.None, true)).IsSuccess.ShouldBeTrue();
        contact.StateFor(organizationId).ShouldBe(AffiliationState.Active);

        contact.FillAffiliationGaps(organizationId, new AffiliationDetails("CTO", ContactRoles.Technical, false)).ShouldBe(["title", "roles"]);
        contact.FillAffiliationGaps(organizationId, new AffiliationDetails("CEO", ContactRoles.DecisionMaker, false)).ShouldBeEmpty();
        contact.AffiliationRoleConflicts(organizationId, ContactRoles.DecisionMaker).ShouldBeTrue();
        contact.AffiliationRoleConflicts(organizationId, ContactRoles.Technical).ShouldBeFalse();

        contact.UpdateAffiliation(organizationId, new AffiliationDetails("CTO", ContactRoles.Technical, false, IsActive: false));
        contact.StateFor(organizationId).ShouldBe(AffiliationState.Ended);
        contact.FillAffiliationGaps(organizationId, new AffiliationDetails("CEO", ContactRoles.DecisionMaker, false)).ShouldBeEmpty();
        contact.StateFor(organizationId).ShouldBe(AffiliationState.Ended);
    }
}

public sealed class ReconciliationPrivacyTests
{
    [Fact]
    public void Every_amount_of_a_reconciliation_line_needs_finance_read()
    {
        var amounts = typeof(ReconciliationLine).GetProperties()
            .Where(p => p.PropertyType == typeof(decimal?))
            .ToList();
        amounts.Count.ShouldBe(5);
        foreach (var amount in amounts)
        {
            // A positional record puts the attribute on the property when it is written [property: ...].
            amount.GetCustomAttribute<SensitiveDataAttribute>().ShouldNotBeNull(amount.Name);
            amount.GetCustomAttribute<SensitiveDataAttribute>()!.Permission.ShouldBe(Permissions.FinanceRead);
        }
    }
}
