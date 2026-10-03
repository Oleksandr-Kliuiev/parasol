using System.Globalization;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.CustomFields.Domain;

/// <summary>The records a company may describe with its own fields (FR-ADM-04).</summary>
public enum CustomFieldEntity
{
    Organization,
    Opportunity,
    Contract,
}

public enum CustomFieldType
{
    Text,
    Number,
    Date,
    Boolean,
    Select,
}

public sealed record CustomFieldDetails(
    CustomFieldEntity Entity,
    string Key,
    string Label,
    CustomFieldType Type,
    IReadOnlyList<string>? Options,
    bool Required,
    int Order,
    string? Hint);

internal static class CustomFieldErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("CF_NOT_FOUND", $"Custom field {id} was not found.");

    public static Error DuplicateKey(string key) => Error.Conflict("CF_DUPLICATE_KEY", $"A field with the key '{key}' already exists for this record type.");

    public static Error OptionsRequired => Error.Validation("CF_OPTIONS_REQUIRED", "A list field needs at least one option.");

    public static Error InvalidValue(string label, string value) =>
        Error.Validation("CF_INVALID_VALUE", $"'{value}' does not fit the field «{label}».", new Dictionary<string, object?> { ["label"] = label });

    public static Error ValueRequired(string label) =>
        Error.Validation("CF_VALUE_REQUIRED", $"The field «{label}» is required.", new Dictionary<string, object?> { ["label"] = label });
}

/// <summary>
/// A field a company adds to a record type without a code change (FR-ADM-04). The definition lives here; the value hangs
/// off the record by id, so no module has to know that custom fields exist.
/// </summary>
public sealed class CustomFieldDefinition : AuditableEntity
{
    private CustomFieldDefinition() { }

    public CustomFieldEntity Entity { get; private set; }
    public string Key { get; private set; } = string.Empty;
    public string Label { get; private set; } = string.Empty;
    public CustomFieldType Type { get; private set; }

    /// <summary>Choices of a list field, in order; empty for every other type.</summary>
    public string[] Options { get; private set; } = [];

    public bool Required { get; private set; }
    public int Order { get; private set; }
    public string? Hint { get; private set; }
    public bool IsActive { get; private set; } = true;

    public static Result<CustomFieldDefinition> Create(CustomFieldDetails details)
    {
        var field = new CustomFieldDefinition();
        var applied = field.Update(details);
        return applied.IsSuccess ? field : applied.Error!;
    }

    public Result Update(CustomFieldDetails details)
    {
        var options = (details.Options ?? [])
            .Select(o => o.Trim())
            .Where(o => o.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(50)
            .ToArray();
        if (details.Type == CustomFieldType.Select && options.Length == 0)
        {
            return CustomFieldErrors.OptionsRequired;
        }

        Entity = details.Entity;
        Key = NormalizeKey(details.Key);
        Label = details.Label.Trim();
        Type = details.Type;
        Options = details.Type == CustomFieldType.Select ? options : [];
        Required = details.Required;
        Order = details.Order;
        Hint = string.IsNullOrWhiteSpace(details.Hint) ? null : details.Hint.Trim();
        return Result.Success();
    }

    public void SetActive(bool active) => IsActive = active;

    /// <summary>Keys are what an export or an integration reads, so they are lowercase and free of spaces.</summary>
    public static string NormalizeKey(string key) =>
        new(key.Trim().ToLowerInvariant().Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray());

    /// <summary>Checks a value against the field and returns it in the stored form; null clears the value.</summary>
    public Result<string?> Normalize(string? value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        if (text is null)
        {
            return Required ? CustomFieldErrors.ValueRequired(Label) : Result<string?>.Success(null);
        }

        switch (Type)
        {
            case CustomFieldType.Number:
                return decimal.TryParse(text.Replace(',', '.'), NumberStyles.Number, CultureInfo.InvariantCulture, out var number)
                    ? number.ToString("0.####", CultureInfo.InvariantCulture)
                    : CustomFieldErrors.InvalidValue(Label, text);
            case CustomFieldType.Date:
                return DateOnly.TryParse(text, CultureInfo.InvariantCulture, out var date)
                    ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : CustomFieldErrors.InvalidValue(Label, text);
            case CustomFieldType.Boolean:
                return text.ToLowerInvariant() is "true" or "false"
                    ? text.ToLowerInvariant()
                    : CustomFieldErrors.InvalidValue(Label, text);
            case CustomFieldType.Select:
                var option = Array.Find(Options, o => string.Equals(o, text, StringComparison.OrdinalIgnoreCase));
                return option ?? (Result<string?>)CustomFieldErrors.InvalidValue(Label, text);
            default:
                return text.Length <= 1000 ? text : CustomFieldErrors.InvalidValue(Label, text);
        }
    }
}

/// <summary>One record's answer to one custom field.</summary>
public sealed class CustomFieldValue : AuditableEntity
{
    private CustomFieldValue() { }

    public Guid DefinitionId { get; private set; }
    public CustomFieldEntity Entity { get; private set; }
    public Guid EntityId { get; private set; }
    public string Value { get; private set; } = string.Empty;

    public static CustomFieldValue Create(CustomFieldDefinition definition, Guid entityId, string value) => new()
    {
        DefinitionId = definition.Id,
        Entity = definition.Entity,
        EntityId = entityId,
        Value = value,
    };

    public void Set(string value) => Value = value;
}
