using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Sales.Domain;

/// <summary>
/// The wording around the numbers: opening paragraph, terms and the footer of the PDF, per language (docs/02 §6 reference
/// data). Administrators keep them; a quote copies the texts when it is created, so editing a template never changes a
/// quote that is already out.
/// </summary>
public sealed class QuoteTemplate : AuditableEntity
{
    private QuoteTemplate() { }

    public string Name { get; private set; } = string.Empty;

    /// <summary>nb or en — the language of the document, not of the CRM interface.</summary>
    public string Language { get; private set; } = "nb";

    public string? IntroText { get; private set; }
    public string? TermsText { get; private set; }
    public string? FooterText { get; private set; }

    /// <summary>How long quotes made from this template stay valid.</summary>
    public int ValidityDays { get; private set; }

    public bool IsDefault { get; private set; }
    public bool IsActive { get; private set; } = true;

    public static Result<QuoteTemplate> Create(QuoteTemplateData data)
    {
        var template = new QuoteTemplate();
        var applied = template.Update(data);
        return applied.IsSuccess ? template : applied.Error!;
    }

    public Result Update(QuoteTemplateData data)
    {
        if (string.IsNullOrWhiteSpace(data.Name))
        {
            return Error.Validation("SAL_TEMPLATE_NAME", "The template needs a name.");
        }

        if (data.ValidityDays is < 1 or > 365)
        {
            return Error.Validation("SAL_TEMPLATE_VALIDITY", "Quotes stay valid between 1 and 365 days.");
        }

        Name = data.Name.Trim();
        Language = data.Language is "en" ? "en" : "nb";
        IntroText = Clean(data.IntroText);
        TermsText = Clean(data.TermsText);
        FooterText = Clean(data.FooterText);
        ValidityDays = data.ValidityDays;
        IsActive = data.IsActive;
        return Result.Success();
    }

    public void MakeDefault() => IsDefault = true;

    public void ClearDefault() => IsDefault = false;

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed record QuoteTemplateData(
    string Name,
    string Language,
    string? IntroText,
    string? TermsText,
    string? FooterText,
    int ValidityDays,
    bool IsActive = true);
