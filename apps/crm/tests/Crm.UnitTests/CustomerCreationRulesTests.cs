using Crm.Integrations.CloudAlly;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Huntress;

namespace Crm.UnitTests;

/// <summary>
/// M43: the rules of creating a customer at a vendor from the "Connect services" wizard — the allow-list naming a CRM organization that
/// has no vendor id yet, the Huntress organization key, CloudAlly's data center and the password made for a new account.
/// </summary>
public class CustomerCreationRulesTests
{
    private static readonly Guid Organization = Guid.Parse("0c5b6a1e-0000-4000-8000-00000000c0de");

    private static VendorActionSwitches Switches(params string[] allowed) => new(true, true, true, false, allowed, ["organization.create", "ticket.reply"]);

    [Fact]
    public void A_target_without_a_vendor_id_passes_an_allow_list_only_when_the_list_names_its_crm_organization()
    {
        VendorActionRules.CheckSwitches(Switches(), "organization.create", null, credentials: true, Organization).ShouldBeNull("an empty list allows everyone");
        VendorActionRules.CheckSwitches(Switches("17"), "organization.create", null, credentials: true, Organization)!.Code.ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
        VendorActionRules.CheckSwitches(Switches("17", Organization.ToString("D").ToUpperInvariant()), "organization.create", null, credentials: true, Organization)
            .ShouldBeNull("the CRM id lets the test customer be created");
        VendorActionRules.CheckSwitches(Switches("17"), "organization.create", null, credentials: true).ShouldNotBeNull("no organization, no pass");
    }

    [Fact]
    public void A_target_with_a_vendor_id_is_checked_by_that_id_and_never_by_its_crm_organization()
    {
        VendorActionRules.CheckSwitches(Switches(Organization.ToString("D")), "ticket.reply", "42", credentials: true, Organization)!.Code
            .ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
        VendorActionRules.CheckSwitches(Switches("42"), "ticket.reply", "42", credentials: true, Organization).ShouldBeNull();
    }

    [Theory]
    [InlineData("Fjord IT AS", "fjord-it")]
    [InlineData("Ærlig Østlandske Åsgård ASA", "aerlig-ostlandske-asgard")]
    [InlineData("  Café Müller & Søn  ", "cafe-muller-son")]
    [InlineData("AS", "as")]
    [InlineData("!!!", "kunde")]
    [InlineData("Bergen Bryggeri SA", "bergen-bryggeri")]
    public void A_huntress_key_is_proposed_from_the_customers_name(string name, string key)
    {
        HuntressOrganizationKey.Propose(name).ShouldBe(key);
        HuntressOrganizationKey.IsValid(key).ShouldBeTrue();
    }

    [Fact]
    public void A_long_name_gives_a_key_of_at_most_64_characters_without_a_trailing_hyphen()
    {
        var key = HuntressOrganizationKey.Propose(string.Join(' ', Enumerable.Repeat("Langt navn", 12)));
        key.Length.ShouldBeLessThanOrEqualTo(HuntressOrganizationKey.MaxLength);
        key.ShouldNotEndWith("-");
        HuntressOrganizationKey.IsValid(key).ShouldBeTrue();
    }

    [Theory]
    [InlineData("fjord-it", true)]
    [InlineData("a", true)]
    [InlineData("Fjord-IT", false)]
    [InlineData("-fjord", false)]
    [InlineData("fjord-", false)]
    [InlineData("fjord it", false)]
    [InlineData("fjord_it", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Only_lower_case_letters_digits_and_inner_hyphens_make_a_key(string? key, bool valid) =>
        HuntressOrganizationKey.IsValid(key).ShouldBe(valid);

    [Fact]
    public void A_key_longer_than_64_characters_is_refused() =>
        HuntressOrganizationKey.IsValid(new string('a', 65)).ShouldBeFalse();

    [Theory]
    [InlineData(null, "EU")]
    [InlineData("EU", "EU")]
    [InlineData("eu_stockholm", "EU_STOCKHOLM")]
    [InlineData("US_EST", "EU")]
    [InlineData("LONDON", "EU")]
    public void A_new_account_is_proposed_in_a_data_center_of_the_eu(string? configured, string region) =>
        CloudAllyCreateAccountAction.DefaultRegion(configured).ShouldBe(region);

    [Fact]
    public void The_password_made_for_a_new_account_is_random_long_and_mixed()
    {
        var passwords = Enumerable.Range(0, 200).Select(_ => CloudAllyAccountPassword.New()).ToList();
        passwords.Distinct().Count().ShouldBe(passwords.Count);
        passwords.ShouldAllBe(p => p.Length == 24 && p.Any(char.IsAsciiLetterLower) && p.Any(char.IsAsciiLetterUpper) && p.Any(char.IsAsciiDigit) &&
                                   p.Any(c => "!#%+-=?@".Contains(c)));
    }
}
