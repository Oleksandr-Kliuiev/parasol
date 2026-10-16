using Crm.Catalog.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Catalog.Domain;

public enum PriceListStatus
{
    Draft,
    Active,
}

public sealed class PriceList : AuditableEntity
{
    private PriceList() { }

    public string Name { get; private set; } = string.Empty;
    public string CustomerCategory { get; private set; } = string.Empty;
    public DateOnly ValidFrom { get; private set; }
    public DateOnly? ValidTo { get; private set; }
    public string Currency { get; private set; } = "NOK";
    public PriceListStatus Status { get; private set; }

    public static Result<PriceList> Create(string name, string customerCategory, DateOnly validFrom, DateOnly? validTo, string currency)
    {
        var list = new PriceList { Status = PriceListStatus.Draft };
        var applied = list.Update(name, customerCategory, validFrom, validTo, currency);
        return applied.IsSuccess ? list : applied.Error!;
    }

    public Result Update(string name, string customerCategory, DateOnly validFrom, DateOnly? validTo, string currency)
    {
        if (validTo is { } to && to < validFrom)
        {
            return Error.Validation("CAT_INVALID_PERIOD", "The price list must end on or after its start date.");
        }

        Name = name.Trim();
        CustomerCategory = Domain.CustomerCategory.NormalizeCode(customerCategory);
        ValidFrom = validFrom;
        ValidTo = validTo;
        Currency = currency.Trim().ToUpperInvariant();
        return Result.Success();
    }

    public bool Covers(DateOnly date) => ValidFrom <= date && (ValidTo is null || date <= ValidTo);

    /// <summary>Two price lists of the same category may not be active on the same day (BR-CAT-01).</summary>
    public bool Overlaps(PriceList other) =>
        other.Id != Id &&
        other.CustomerCategory == CustomerCategory &&
        other.ValidFrom <= (ValidTo ?? DateOnly.MaxValue) &&
        ValidFrom <= (other.ValidTo ?? DateOnly.MaxValue);

    public void Activate()
    {
        if (Status != PriceListStatus.Active)
        {
            Status = PriceListStatus.Active;
            Raise(new PriceListActivated(Id, CustomerCategory, ValidFrom, ValidTo));
        }
    }

    public void Deactivate() => Status = PriceListStatus.Draft;
}

/// <summary>Price of one product in a price list. Microsoft licences may be priced from the partner price (BR-CAT-02).</summary>
public sealed class PriceListItem : AuditableEntity
{
    private PriceListItem() { }

    public Guid PriceListId { get; private set; }
    public Guid ProductId { get; private set; }
    public decimal UnitPrice { get; private set; }
    public decimal? UnitCost { get; private set; }
    public decimal? PartnerPrice { get; private set; }
    public string? PartnerCurrency { get; private set; }
    public decimal? ExchangeRate { get; private set; }

    public static PriceListItem Create(Guid priceListId, Guid productId) => new() { PriceListId = priceListId, ProductId = productId };

    public void SetPrice(decimal unitPrice, decimal? unitCost)
    {
        UnitPrice = decimal.Round(unitPrice, 2);
        UnitCost = unitCost is { } cost ? decimal.Round(cost, 2) : null;
        PartnerPrice = null;
        PartnerCurrency = null;
        ExchangeRate = null;
    }

    /// <summary>Sales price = partner price × exchange rate × (1 + markup), rounded; cost = partner price × exchange rate.</summary>
    public void SetFromPartnerPrice(decimal partnerPrice, string partnerCurrency, decimal exchangeRate, decimal markupPct, PriceRounding rounding)
    {
        UnitPrice = LicensePricing.SalesPrice(partnerPrice, exchangeRate, markupPct, rounding);
        UnitCost = decimal.Round(partnerPrice * exchangeRate, 2, MidpointRounding.AwayFromZero);
        PartnerPrice = partnerPrice;
        PartnerCurrency = partnerCurrency.Trim().ToUpperInvariant();
        ExchangeRate = exchangeRate;
    }
}

public enum PriceRounding
{
    /// <summary>Øre precision.</summary>
    None,
    Nearest1,
    Nearest5,
    Nearest10,

    /// <summary>Always up to the next whole krone.</summary>
    Up1,
}

public static class LicensePricing
{
    public static decimal SalesPrice(decimal partnerPrice, decimal exchangeRate, decimal markupPct, PriceRounding rounding)
    {
        var raw = partnerPrice * exchangeRate * (1 + (markupPct / 100m));
        return rounding switch
        {
            PriceRounding.Nearest1 => decimal.Round(raw, 0, MidpointRounding.AwayFromZero),
            PriceRounding.Nearest5 => decimal.Round(raw / 5m, 0, MidpointRounding.AwayFromZero) * 5m,
            PriceRounding.Nearest10 => decimal.Round(raw / 10m, 0, MidpointRounding.AwayFromZero) * 10m,
            PriceRounding.Up1 => decimal.Ceiling(decimal.Round(raw, 2)),
            _ => decimal.Round(raw, 2, MidpointRounding.AwayFromZero),
        };
    }
}

/// <summary>BR-CAT-01: of the active price lists of a category, the one covering the date wins; otherwise the list price.</summary>
public static class PriceResolver
{
    public static ResolvedPrice Resolve(Product product, IEnumerable<(PriceList List, PriceListItem Item)> candidates, DateOnly date)
    {
        var match = candidates
            .Where(c => c.List.Status == PriceListStatus.Active && c.List.Covers(date) && c.Item.ProductId == product.Id)
            .OrderByDescending(c => c.List.ValidFrom)
            .Select(c => ((PriceList, PriceListItem)?)c)
            .FirstOrDefault();

        return match is var (list, item)
            ? new ResolvedPrice(product.Id, item.UnitPrice, item.UnitCost ?? product.UnitCost, list.Currency, list.Id, list.Name)
            : new ResolvedPrice(product.Id, product.ListPrice, product.UnitCost, product.Currency, null, null);
    }
}
