namespace Crm.SharedKernel.Application;

/// <summary>How record scope is applied (DEV-09, SEC-AZ-03).</summary>
public enum RecordScopeMode
{
    /// <summary>
    /// Roles without the "every record" permission of a kind see only their own or assigned records of it: a salesperson
    /// the quotes they own, a technician the projects they are on.
    /// </summary>
    Restricted,

    /// <summary>Everyone holding a kind's read permission sees all of its records — the behaviour before DEV-09.</summary>
    Open,
}

/// <summary>
/// Which records of a kind the caller may see and change (DEV-09). The permission decides whether a role sees a kind at all;
/// the scope decides which of its records. The module that owns the records applies the scope to every query that reaches
/// them — lists, loads by id, documents, contract methods — so no path depends on a filter the caller chose.
/// </summary>
public interface IRecordScope
{
    RecordScopeMode Mode { get; }

    /// <summary>
    /// Null when the caller sees every record of the kind: the Open mode, background work, or a role holding
    /// <paramref name="everyRecordPermission"/>. Otherwise the user whose own or assigned records are the only visible ones
    /// (<see cref="Guid.Empty"/> when the caller is no CRM user, so nothing matches).
    /// </summary>
    Guid? LimitedTo(string everyRecordPermission);
}

/// <summary>
/// A module's part of the record scope report (DEV-09): to whom its records are assigned and how many have nobody. Before
/// the Restricted mode reaches an environment with data, it shows who would keep and who would lose sight of what (runbook 11).
/// Counts are across all records, whatever the caller's own scope: the endpoint is for those who review access.
/// </summary>
public interface IRecordScopeReporter
{
    /// <summary>The kind of record, e.g. "quotes"; stable, used as a translation key.</summary>
    string Kind { get; }

    /// <summary>The permission that lets a role see the kind at all.</summary>
    string ReadPermission { get; }

    /// <summary>The permission that lets a role see every record of the kind.</summary>
    string EveryRecordPermission { get; }

    Task<RecordScopeCounts> CountAsync(CancellationToken cancellationToken);
}

/// <param name="Total">Records of the kind.</param>
/// <param name="WithoutAssignee">Records nobody owns or is assigned to: in the Restricted mode only roles that see everything see them.</param>
/// <param name="Assignees">Records per person they are owned by or assigned to.</param>
public sealed record RecordScopeCounts(int Total, int WithoutAssignee, IReadOnlyDictionary<Guid, int> Assignees);
