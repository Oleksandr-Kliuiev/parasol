using Crm.Customers.Contracts;
using Crm.Customers.Domain;

namespace Crm.UnitTests;

public class OrgNumberTests
{
    [Theory]
    [InlineData("923609016")] // Equinor ASA
    [InlineData("974760673")] // Brønnøysundregistrene
    [InlineData("923 609 016")]
    public void Valid_numbers_pass_mod11(string value) => OrgNumber.IsValid(value).ShouldBeTrue();

    [Theory]
    [InlineData("923609017")]
    [InlineData("12345678")]
    [InlineData("1234567890")]
    [InlineData("92360901A")]
    [InlineData("")]
    [InlineData(null)]
    public void Invalid_numbers_fail(string? value) => OrgNumber.IsValid(value).ShouldBeFalse();

    [Fact]
    public void Parse_normalizes_whitespace() => OrgNumber.Parse(" 923 609 016 ").Value.ShouldBe("923609016");

    [Fact]
    public void Parse_treats_blank_as_absent() => OrgNumber.Parse("  ").Value.ShouldBeNull();
}

public class OrganizationTests
{
    private static OrganizationDetails Details(string name = "Fjord IT AS", string? orgNumber = "923609016", string[]? domains = null) =>
        new(name, orgNumber, "as", OrganizationStatus.Prospect, null, null, null, "Post@Fjord.no", null, false, null, null,
            new Address(" Storgata 1 ", "0155", "Oslo", "no"), null, null, domains);

    [Fact]
    public void Create_raises_event_and_normalizes_input()
    {
        var organization = Organization.Create(Details(domains: ["@Fjord.NO", "fjord.no", " fjordit.no "])).Value;

        organization.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<OrganizationCreated>().OrgNumber.ShouldBe("923609016");
        organization.LegalForm.ShouldBe("AS");
        organization.Email.ShouldBe("post@fjord.no");
        organization.PostalAddress.ShouldBe(new Address("Storgata 1", "0155", "Oslo", "NO"));
        organization.Domains.ShouldBe(["fjord.no", "fjordit.no"]);
        organization.RegistryStatus.ShouldBe(BrregStatus.Unknown);
    }

    [Theory]
    [InlineData("havbris.no", "https://havbris.no")]
    [InlineData("http://havbris.no", "http://havbris.no")]
    [InlineData(" ", null)]
    public void Website_gets_a_scheme(string input, string? expected) =>
        Organization.Create(Details() with { Website = input }).Value.Website.ShouldBe(expected);

    [Fact]
    public void Address_with_only_country_is_empty() =>
        new Address(" ", null, "", "no").Normalize().ShouldBe(Address.Empty);

    [Fact]
    public void Create_rejects_invalid_org_number()
    {
        var result = Organization.Create(Details(orgNumber: "923609017"));
        result.IsSuccess.ShouldBeFalse();
        result.Error!.Code.ShouldBe("CUS_INVALID_ORGNR");
    }

    [Fact]
    public void Create_requires_name() =>
        Organization.Create(Details(name: " ")).Error!.Code.ShouldBe("CUS_NAME_REQUIRED");

    [Fact]
    public void Registry_status_change_raises_event_only_after_first_check()
    {
        var organization = Organization.Create(Details()).Value;
        organization.ClearDomainEvents();

        organization.ApplyRegistryStatus(BrregStatus.Active, DateTimeOffset.UtcNow);
        organization.DomainEvents.ShouldBeEmpty();

        organization.ApplyRegistryStatus(BrregStatus.Bankrupt, DateTimeOffset.UtcNow);
        var changed = organization.DomainEvents.ShouldHaveSingleItem().ShouldBeOfType<OrganizationRegistryStatusChanged>();
        changed.Previous.ShouldBe(BrregStatus.Active);
        changed.Current.ShouldBe(BrregStatus.Bankrupt);
    }

    [Fact]
    public void Changing_org_number_resets_registry_status()
    {
        var organization = Organization.Create(Details()).Value;
        organization.ApplyRegistryStatus(BrregStatus.Active, DateTimeOffset.UtcNow);

        organization.Update(Details(orgNumber: "974760673")).IsSuccess.ShouldBeTrue();

        organization.RegistryStatus.ShouldBe(BrregStatus.Unknown);
        organization.RegistryCheckedAt.ShouldBeNull();
    }
}

public class ContactTests
{
    private static Contact NewContact() =>
        Contact.Create(new ContactDetails("Kari", "Nordmann", " Kari@Fjord.no ", null, null, "nb")).Value;

    [Fact]
    public void Email_is_normalized() => NewContact().Email.ShouldBe("kari@fjord.no");

    [Fact]
    public void Same_organization_cannot_be_affiliated_twice()
    {
        var contact = NewContact();
        var organizationId = Guid.NewGuid();
        contact.Affiliate(organizationId, new AffiliationDetails("CFO", ContactRoles.Billing, true)).IsSuccess.ShouldBeTrue();

        var again = contact.Affiliate(organizationId, new AffiliationDetails(null, ContactRoles.None, false));

        again.Error!.Code.ShouldBe("CUS_DUPLICATE_CONTACT");
    }

    [Fact]
    public void Inactive_affiliation_is_reactivated_and_cannot_be_primary_while_inactive()
    {
        var contact = NewContact();
        var organizationId = Guid.NewGuid();
        contact.Affiliate(organizationId, new AffiliationDetails("IT", ContactRoles.Technical, true));
        contact.UpdateAffiliation(organizationId, new AffiliationDetails("IT", ContactRoles.Technical, IsPrimary: true, IsActive: false));

        var affiliation = contact.Affiliations.ShouldHaveSingleItem();
        affiliation.IsActive.ShouldBeFalse();
        affiliation.IsPrimary.ShouldBeFalse();

        contact.Affiliate(organizationId, new AffiliationDetails("IT", ContactRoles.Technical | ContactRoles.DecisionMaker, true)).IsSuccess.ShouldBeTrue();
        contact.Affiliations.ShouldHaveSingleItem().IsActive.ShouldBeTrue();
    }
}

public class DuplicateDetectorTests
{
    private static DuplicateCandidate Org(string name, string? orgNumber = null, string? email = null, string? phone = null, params string[] domains) =>
        new(Guid.NewGuid(), name, orgNumber, email, phone, domains);

    [Theory]
    [InlineData("Fjord IT AS", "fjord it")]
    [InlineData("FJORD-IT A/S", "fjord it")]
    [InlineData("Bergen Regnskap ENK", "bergen regnskap")]
    [InlineData("AS", "as")]
    [InlineData("Ålesund Data Holding AS", "ålesund data holding")]
    public void Normalizes_names_without_legal_form(string input, string expected) =>
        DuplicateDetector.NormalizeName(input).ShouldBe(expected);

    [Fact]
    public void Same_name_with_different_legal_form_is_a_duplicate()
    {
        var a = Org("Fjord IT AS");
        var b = Org("Fjord-IT", email: "post@fjordit.no");

        var pair = DuplicateDetector.Find([a, b], new HashSet<(Guid, Guid)>()).ShouldHaveSingleItem();

        pair.Reasons.ShouldBe([DuplicateReason.SameName]);
    }

    [Fact]
    public void Collects_all_reasons_for_a_pair()
    {
        var a = Org("Nordlys Drift AS", email: "post@nordlys.no", phone: "+47 22 00 00 00", domains: "nordlys.no");
        var b = Org("Nordlys Drift", email: "faktura@nordlys.no", phone: "22000000", domains: "nordlys.no");

        var pair = DuplicateDetector.Find([a, b], new HashSet<(Guid, Guid)>()).ShouldHaveSingleItem();

        pair.Reasons.ShouldBe([DuplicateReason.SameName, DuplicateReason.SharedDomain, DuplicateReason.SameEmailDomain, DuplicateReason.SamePhone]);
    }

    [Fact]
    public void Different_org_numbers_are_never_duplicates()
    {
        var parent = Org("Konsern AS", "923609016", domains: "konsern.no");
        var subsidiary = Org("Konsern Drift AS", "974760673", domains: "konsern.no");

        DuplicateDetector.Find([parent, subsidiary], new HashSet<(Guid, Guid)>()).ShouldBeEmpty();
    }

    [Fact]
    public void Public_mail_domains_and_dismissed_pairs_are_ignored()
    {
        var a = Org("Ola Hansen Snekker", email: "ola@gmail.com");
        var b = Org("Kari Hansen Frisør", email: "kari@gmail.com");
        var c = Org("Havbris AS");
        var d = Org("Havbris");

        var dismissed = new HashSet<(Guid, Guid)> { DuplicateDetector.PairKey(c.Id, d.Id) };

        DuplicateDetector.Find([a, b, c, d], dismissed).ShouldBeEmpty();
    }
}

public class OrganizationMergeDomainTests
{
    [Fact]
    public void Absorb_fills_empty_fields_and_keeps_target_values()
    {
        var target = Organization.Create(new OrganizationDetails("Fjord IT AS", null, "AS", OrganizationStatus.Prospect, null, null, "22 00 00 00",
            null, null, false, null, null, null, null, null, ["fjordit.no"])).Value;
        var source = Organization.Create(new OrganizationDetails("Fjord-IT", "923609016", null, OrganizationStatus.Customer, "62.020", "https://fjordit.no",
            "99 99 99 99", "post@fjordit.no", null, true, null, null, null, new Address("Storgata 1", "0155", "Oslo", "NO"), null, ["fjordit.com"])).Value;

        target.AbsorbFrom(source.Snapshot());

        target.Name.ShouldBe("Fjord IT AS");
        target.Phone.ShouldBe("22 00 00 00");
        target.OrgNumber.ShouldBe("923609016");
        target.NaceCode.ShouldBe("62.020");
        target.Email.ShouldBe("post@fjordit.no");
        target.Status.ShouldBe(OrganizationStatus.Customer);
        target.EhfEnabled.ShouldBeTrue();
        target.VisitAddress.City.ShouldBe("Oslo");
        target.Domains.ShouldBe(["fjordit.com", "fjordit.no"]);
    }
}
