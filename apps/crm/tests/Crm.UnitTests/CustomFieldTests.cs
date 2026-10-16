using Crm.CustomFields.Domain;

namespace Crm.UnitTests;

public class CustomFieldTests
{
    private static CustomFieldDetails Details(
        CustomFieldType type = CustomFieldType.Text,
        string key = "Kunde segment",
        IReadOnlyList<string>? options = null,
        bool required = false) =>
        new(CustomFieldEntity.Organization, key, "Segment", type, options, required, 1, null);

    private static CustomFieldDefinition Field(
        CustomFieldType type = CustomFieldType.Text, IReadOnlyList<string>? options = null, bool required = false) =>
        CustomFieldDefinition.Create(Details(type, options: options, required: required)).Value;

    [Fact]
    public void A_key_becomes_a_safe_identifier()
    {
        Field().Key.ShouldBe("kunde_segment");
        // Norwegian letters are letters: they stay, only spaces and punctuation become underscores.
        CustomFieldDefinition.NormalizeKey(" Neste Møte ").ShouldBe("neste_møte");
        CustomFieldDefinition.NormalizeKey("ARR (NOK)").ShouldBe("arr__nok_");
    }

    [Fact]
    public void A_list_field_needs_options_and_keeps_them_in_order_without_duplicates()
    {
        CustomFieldDefinition.Create(Details(CustomFieldType.Select)).Error!.Code.ShouldBe("CF_OPTIONS_REQUIRED");

        var field = Field(CustomFieldType.Select, ["Liten", "Mellomstor", "liten", " Stor "]);
        field.Options.ShouldBe(["Liten", "Mellomstor", "Stor"]);
        field.Normalize("stor").Value.ShouldBe("Stor");
        field.Normalize("Enorm").Error!.Code.ShouldBe("CF_INVALID_VALUE");
    }

    [Fact]
    public void Numbers_and_dates_are_stored_in_one_shape()
    {
        Field(CustomFieldType.Number).Normalize("1 234,5").Error!.Code.ShouldBe("CF_INVALID_VALUE");
        Field(CustomFieldType.Number).Normalize("1234,50").Value.ShouldBe("1234.5");
        Field(CustomFieldType.Date).Normalize("2026-09-23").Value.ShouldBe("2026-09-23");
        Field(CustomFieldType.Date).Normalize("i morgen").Error!.Code.ShouldBe("CF_INVALID_VALUE");
        Field(CustomFieldType.Boolean).Normalize("TRUE").Value.ShouldBe("true");
        Field(CustomFieldType.Boolean).Normalize("ja").Error!.Code.ShouldBe("CF_INVALID_VALUE");
    }

    [Fact]
    public void An_empty_value_clears_the_field_unless_it_is_required()
    {
        Field().Normalize("  ").Value.ShouldBeNull();
        Field(required: true).Normalize(null).Error!.Code.ShouldBe("CF_VALUE_REQUIRED");
    }

    [Fact]
    public void Changing_the_type_away_from_a_list_drops_the_options()
    {
        var field = Field(CustomFieldType.Select, ["A", "B"]);
        field.Update(new CustomFieldDetails(CustomFieldEntity.Organization, "segment", "Segment", CustomFieldType.Text, ["A"], false, 2, "Hint"))
            .IsSuccess.ShouldBeTrue();

        field.Options.ShouldBeEmpty();
        field.Hint.ShouldBe("Hint");
        field.Order.ShouldBe(2);
    }
}
