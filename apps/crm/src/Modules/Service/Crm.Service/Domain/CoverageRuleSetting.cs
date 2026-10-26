using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// What a person set for one coverage rule (M40): whether it checks at all and its limit (the days an Atera agent may be silent).
/// Stored the first time someone changes the rule; until then the rule runs with its defaults. Audited.
/// </summary>
public sealed class CoverageRuleSetting : AuditableEntity
{
    public const int CodeLength = 64;

    private CoverageRuleSetting() { }

    public string Code { get; private set; } = string.Empty;
    public bool Enabled { get; private set; }

    /// <summary>The limit in force, in the rule's unit; null for a rule without one.</summary>
    public int? Threshold { get; private set; }

    public static CoverageRuleSetting For(string code, bool enabled, int? threshold) =>
        new() { Code = code, Enabled = enabled, Threshold = threshold };

    public void Change(bool enabled, int? threshold)
    {
        Enabled = enabled;
        Threshold = threshold;
    }
}
