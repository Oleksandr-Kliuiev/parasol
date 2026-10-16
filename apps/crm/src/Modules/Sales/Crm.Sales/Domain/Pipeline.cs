using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Sales.Domain;

/// <summary>A stage of the sales pipeline. Configurable (docs/02 §4.3); the defaults come with the initial migration.</summary>
public sealed class PipelineStage : AuditableEntity
{
    private PipelineStage() { }

    public PipelineStage(Guid id, string name, int probability, int order, bool isWon, bool isLost) : base(id)
    {
        Name = name;
        Probability = probability;
        Order = order;
        IsWon = isWon;
        IsLost = isLost;
    }

    public string Name { get; private set; } = string.Empty;

    /// <summary>Default win probability in per cent; an opportunity may override it.</summary>
    public int Probability { get; private set; }

    public int Order { get; private set; }

    public bool IsWon { get; private set; }

    public bool IsLost { get; private set; }

    public bool IsActive { get; private set; } = true;

    public static Result<PipelineStage> Create(string name, int probability, int order) =>
        Validate(name, probability) ?? (Result<PipelineStage>)new PipelineStage(SequentialId.New(), name.Trim(), probability, order, isWon: false, isLost: false);

    public Result Update(string name, int probability, int order, bool isActive)
    {
        if (Validate(name, probability) is { } error)
        {
            return error;
        }

        Name = name.Trim();
        // Won and lost stages keep their 100 % / 0 %: the forecast depends on it.
        Probability = IsWon ? 100 : IsLost ? 0 : probability;
        Order = order;
        IsActive = isActive;
        return Result.Success();
    }

    private static Error? Validate(string name, int probability) =>
        string.IsNullOrWhiteSpace(name) ? Error.Validation("SAL_STAGE_NAME_REQUIRED", "The stage needs a name.")
        : probability is < 0 or > 100 ? Error.Validation("SAL_STAGE_PROBABILITY", "Probability must be between 0 and 100 %.")
        : null;
}
