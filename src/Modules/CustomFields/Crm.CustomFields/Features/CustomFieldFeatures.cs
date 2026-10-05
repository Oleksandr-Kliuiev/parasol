using Crm.CustomFields.Domain;
using Crm.CustomFields.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.EntityFrameworkCore;

namespace Crm.CustomFields.Features;

public sealed record CustomFieldRequest(
    CustomFieldEntity Entity,
    string Key,
    string Label,
    CustomFieldType Type,
    IReadOnlyList<string>? Options,
    bool Required,
    int Order,
    string? Hint)
{
    internal CustomFieldDetails ToDetails() => new(Entity, Key, Label, Type, Options, Required, Order, Hint);
}

internal sealed class CustomFieldRequestValidator : AbstractValidator<CustomFieldRequest>
{
    public CustomFieldRequestValidator()
    {
        RuleFor(x => x.Key).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Label).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Order).InclusiveBetween(0, 1000);
        RuleFor(x => x.Hint).MaximumLength(256);
    }
}

public sealed record CustomFieldDto(
    Guid Id,
    CustomFieldEntity Entity,
    string Key,
    string Label,
    CustomFieldType Type,
    IReadOnlyList<string> Options,
    bool Required,
    int Order,
    string? Hint,
    bool IsActive);

/// <summary>A field together with this record's answer, which is what a card needs to draw it.</summary>
public sealed record CustomFieldValueDto(
    Guid DefinitionId,
    string Key,
    string Label,
    CustomFieldType Type,
    IReadOnlyList<string> Options,
    bool Required,
    string? Hint,
    string? Value);

public sealed record SaveCustomFieldValuesRequest(IReadOnlyDictionary<string, string?> Values);

internal sealed class SaveCustomFieldValuesRequestValidator : AbstractValidator<SaveCustomFieldValuesRequest>
{
    public SaveCustomFieldValuesRequestValidator()
    {
        RuleFor(x => x.Values).NotNull().Must(values => values is null || values.Count <= 200).WithMessage("Send at most 200 fields at a time.");
        RuleForEach(x => x.Values).Must(pair => pair.Key.Length is > 0 and <= 64).WithMessage("A field key is 1-64 characters.")
            .Must(pair => pair.Value is null || pair.Value.Length <= 1000).WithMessage("A value holds at most 1000 characters.")
            .When(x => x.Values is not null);
    }
}

/// <summary>
/// Custom fields (FR-ADM-04): definitions per record type, and the values of one record. Nothing here knows what an
/// organization or a contract is — the entity type and id are all the module stores, so no module depends on it.
/// </summary>
internal sealed class CustomFieldService(CustomFieldsDbContext db)
{
    public async Task<IReadOnlyList<CustomFieldDto>> ListAsync(CustomFieldEntity? entity, bool includeInactive, CancellationToken ct)
    {
        var definitions = await db.Definitions.AsNoTracking()
            .Where(d => (entity == null || d.Entity == entity) && (includeInactive || d.IsActive))
            .OrderBy(d => d.Entity).ThenBy(d => d.Order).ThenBy(d => d.Label)
            .ToListAsync(ct);
        return definitions.ConvertAll(Map);
    }

    public async Task<Result<CustomFieldDto>> SaveAsync(Guid? id, CustomFieldRequest request, CancellationToken ct)
    {
        var key = CustomFieldDefinition.NormalizeKey(request.Key);
        if (await db.Definitions.AnyAsync(d => d.Entity == request.Entity && d.Key == key && (id == null || d.Id != id), ct))
        {
            return Error.Conflict("CF_DUPLICATE_KEY", $"A field with the key '{key}' already exists for this record type.");
        }

        CustomFieldDefinition definition;
        if (id is { } existingId)
        {
            if (await db.Definitions.SingleOrDefaultAsync(d => d.Id == existingId, ct) is not { } existing)
            {
                return Error.NotFound("CF_NOT_FOUND", $"Custom field {existingId} was not found.");
            }

            definition = existing;
            var updated = definition.Update(request.ToDetails());
            if (!updated.IsSuccess)
            {
                return updated.Error!;
            }
        }
        else
        {
            var created = CustomFieldDefinition.Create(request.ToDetails());
            if (!created.IsSuccess)
            {
                return created.Error!;
            }

            definition = created.Value;
            db.Definitions.Add(definition);
        }

        await db.SaveChangesAsync(ct);
        return Map(definition);
    }

    public async Task<Result> SetActiveAsync(Guid id, bool active, CancellationToken ct)
    {
        if (await db.Definitions.SingleOrDefaultAsync(d => d.Id == id, ct) is not { } definition)
        {
            return Error.NotFound("CF_NOT_FOUND", $"Custom field {id} was not found.");
        }

        definition.SetActive(active);
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<Result> DeleteAsync(Guid id, CancellationToken ct)
    {
        if (await db.Definitions.SingleOrDefaultAsync(d => d.Id == id, ct) is not { } definition)
        {
            return Error.NotFound("CF_NOT_FOUND", $"Custom field {id} was not found.");
        }

        // The answers go with the field; keeping them would leave values nobody can read.
        foreach (var value in await db.Values.Where(v => v.DefinitionId == id).ToListAsync(ct))
        {
            value.MarkDeleted();
        }

        definition.MarkDeleted();
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    public async Task<IReadOnlyList<CustomFieldValueDto>> GetValuesAsync(CustomFieldEntity entity, Guid entityId, CancellationToken ct)
    {
        var definitions = await db.Definitions.AsNoTracking()
            .Where(d => d.Entity == entity && d.IsActive)
            .OrderBy(d => d.Order).ThenBy(d => d.Label)
            .ToListAsync(ct);
        if (definitions.Count == 0)
        {
            return [];
        }

        var values = await db.Values.AsNoTracking()
            .Where(v => v.Entity == entity && v.EntityId == entityId)
            .ToDictionaryAsync(v => v.DefinitionId, v => v.Value, ct);

        return definitions.ConvertAll(d => new CustomFieldValueDto(
            d.Id, d.Key, d.Label, d.Type, d.Options, d.Required, d.Hint, values.GetValueOrDefault(d.Id)));
    }

    public async Task<Result<IReadOnlyList<CustomFieldValueDto>>> SaveValuesAsync(
        CustomFieldEntity entity, Guid entityId, IReadOnlyDictionary<string, string?> values, CancellationToken ct)
    {
        var definitions = await db.Definitions.Where(d => d.Entity == entity && d.IsActive).ToListAsync(ct);
        var stored = await db.Values.Where(v => v.Entity == entity && v.EntityId == entityId).ToListAsync(ct);

        foreach (var (key, raw) in values)
        {
            var normalizedKey = CustomFieldDefinition.NormalizeKey(key);
            if (definitions.Find(d => d.Key == normalizedKey) is not { } definition)
            {
                continue;
            }

            var normalized = definition.Normalize(raw);
            if (!normalized.IsSuccess)
            {
                return normalized.Error!;
            }

            var existing = stored.Find(v => v.DefinitionId == definition.Id);
            if (normalized.Value is not { } text)
            {
                existing?.MarkDeleted();
                continue;
            }

            if (existing is null)
            {
                db.Values.Add(CustomFieldValue.Create(definition, entityId, text));
            }
            else
            {
                existing.Set(text);
            }
        }

        await db.SaveChangesAsync(ct);
        var saved = await GetValuesAsync(entity, entityId, ct);
        return Result<IReadOnlyList<CustomFieldValueDto>>.Success(saved);
    }

    private static CustomFieldDto Map(CustomFieldDefinition d) =>
        new(d.Id, d.Entity, d.Key, d.Label, d.Type, d.Options, d.Required, d.Order, d.Hint, d.IsActive);
}
