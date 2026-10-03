using Crm.Customers.Contracts;
using Crm.Integrations.Brreg;

namespace Crm.UnitTests;

public class BrregMappingTests
{
    private static BrregEnhet Enhet(bool konkurs = false, bool avvikling = false, string? slettet = null) => new(
        "923609016", "EQUINOR ASA", new BrregKode("ASA", "Allmennaksjeselskap"), new BrregKode("06.100", "Utvinning av råolje"),
        new BrregAdresse(["Forusbeen 50"], "4035", "STAVANGER", "NO"), null, "www.equinor.com", null, null,
        konkurs, avvikling, false, slettet);

    [Fact]
    public void Maps_registry_fields_to_crm_vocabulary()
    {
        var organization = BrregClient.Map(Enhet());

        organization.LegalForm.ShouldBe("ASA");
        organization.NaceCode.ShouldBe("06.100");
        organization.Website.ShouldBe("https://www.equinor.com");
        organization.BusinessAddress.ShouldBe(new RegistryAddress("Forusbeen 50", "4035", "STAVANGER", "NO"));
        organization.Status.ShouldBe(BrregStatus.Active);
    }

    [Theory]
    [InlineData(true, false, null, BrregStatus.Bankrupt)]
    [InlineData(false, true, null, BrregStatus.UnderDissolution)]
    [InlineData(true, true, "2024-01-01", BrregStatus.Deleted)]
    public void Status_reflects_registry_flags(bool konkurs, bool avvikling, string? slettet, BrregStatus expected) =>
        BrregClient.StatusOf(Enhet(konkurs, avvikling, slettet)).ShouldBe(expected);
}
