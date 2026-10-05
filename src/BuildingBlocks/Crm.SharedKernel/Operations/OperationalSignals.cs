namespace Crm.SharedKernel.Operations;

/// <summary>
/// A low-cardinality operational finding. Keys identify kinds of problems, never customers or documents; counts carry no
/// amounts or personal details. A zero count explicitly reports recovery. UI callers must enforce RequiredPermission.
/// </summary>
public sealed record OperationalSignal(
    string Key, string Category, string Source, string Kind, DateTimeOffset? DetectedAt, int Count,
    string Impact, string Runbook, string? RequiredPermission = null);

/// <summary>A module reads only its own data (or another module's contracts) to contribute operational signals.</summary>
public interface IOperationalSignalSource
{
    Task<IReadOnlyList<OperationalSignal>> ReadAsync(CancellationToken cancellationToken);
}
