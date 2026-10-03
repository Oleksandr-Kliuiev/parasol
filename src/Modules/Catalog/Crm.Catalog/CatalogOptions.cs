using Crm.Catalog.Domain;

namespace Crm.Catalog;

public sealed class CatalogOptions
{
    public const string SectionName = "Catalog";

    /// <summary>Rounding of Microsoft licence prices calculated from partner prices (BR-CAT-02).</summary>
    public PriceRounding LicensePriceRounding { get; set; } = PriceRounding.Nearest1;
}
