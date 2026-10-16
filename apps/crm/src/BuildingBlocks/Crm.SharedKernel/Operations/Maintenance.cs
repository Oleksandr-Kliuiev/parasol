namespace Crm.SharedKernel.Operations;

/// <summary>The CRM as a whole: in normal operation, or read-only for a database restore or an incident (DEV-13, ADR-021).</summary>
public enum MaintenanceMode
{
    Normal,
    ReadOnly,
}

/// <summary>
/// One decision about maintenance: the mode, why, who took it and when. It lives outside the business database (the document
/// store), so a restore of the database cannot lose it, and every replica of crm-web and crm-worker reads the same decision.
/// <see cref="Key"/> names the stored decision; a change names the key it replaces, so two operators cannot overwrite each
/// other unnoticed.
/// </summary>
public sealed record MaintenanceState(MaintenanceMode Mode, string? Reason, string? Reference, string? SetBy, DateTimeOffset At, string? Key)
{
    public static readonly MaintenanceState Normal = new(MaintenanceMode.Normal, null, null, null, DateTimeOffset.MinValue, null);

    public bool IsReadOnly => Mode == MaintenanceMode.ReadOnly;
}

public interface IMaintenanceGate
{
    /// <summary>The last state read, without waiting (synchronous paths); the configuration's while nothing was read yet.</summary>
    MaintenanceState Last { get; }

    /// <summary>The state, read again at most every few seconds per process: for gating requests and database writes.</summary>
    ValueTask<MaintenanceState> CurrentAsync(CancellationToken cancellationToken);

    /// <summary>
    /// The state read from the store now, never from a cache. Asked right before an external effect — an order, an e-mail, a
    /// post — so a replica that cached "normal" a moment ago cannot send once maintenance began. Throws
    /// <see cref="MaintenanceStateUnavailableException"/> when the store cannot be read; the caller then sends nothing.
    /// </summary>
    Task<MaintenanceState> FreshAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Records a decision. <paramref name="expectedKey"/> is the key of the decision the operator saw; another one taken meanwhile
    /// answers with <see cref="MaintenanceConflictException"/>.
    /// </summary>
    Task<MaintenanceState> SetAsync(
        MaintenanceMode mode, string reason, string? reference, string setBy, string? expectedKey, CancellationToken cancellationToken);
}

public static class MaintenanceGateExtensions
{
    /// <summary>
    /// Right before an external effect: the state read now, never from a cache, and an exception unless the CRM is in normal
    /// operation — <see cref="MaintenanceReadOnlyException"/> while it is read-only, <see cref="MaintenanceStateUnavailableException"/>
    /// when the store cannot say (fail closed). A <see cref="MaintenanceScope"/> does not lift it: maintenance allows a few
    /// database writes, never a send.
    /// </summary>
    public static async Task EnsureMaySendAsync(this IMaintenanceGate gate, CancellationToken cancellationToken)
    {
        var state = await gate.FreshAsync(cancellationToken);
        if (state.IsReadOnly)
        {
            throw new MaintenanceReadOnlyException(state);
        }
    }
}

/// <summary>
/// The few writes maintenance allows (DEV-13): the operator's restore reconciliation, the privacy replay after a restore, the
/// worker's heartbeat, ending a session at sign-out, recording a maintenance decision, and the bookkeeping of work that was
/// under way when maintenance began (the outcome of a send that already left). Code opens the scope around exactly that work;
/// any other database write is refused while the CRM is read-only.
/// </summary>
public static class MaintenanceScope
{
    private static readonly AsyncLocal<string?> Purpose = new();

    /// <summary>Why writes are allowed right now, or null when they follow the maintenance state.</summary>
    public static string? AllowedBy => Purpose.Value;

    public static IDisposable AllowWrites(string purpose)
    {
        var previous = Purpose.Value;
        Purpose.Value = purpose;
        return new Restore(previous);
    }

    private sealed class Restore(string? previous) : IDisposable
    {
        public void Dispose() => Purpose.Value = previous;
    }
}

/// <summary>
/// A write or a send refused because the CRM is read-only; the web host answers 503 <c>MAINTENANCE_READ_ONLY</c>. Not an
/// <see cref="InvalidOperationException"/>, so code that tolerates those (a misconfigured integration) does not swallow it.
/// </summary>
public sealed class MaintenanceReadOnlyException(MaintenanceState state)
    : Exception("The CRM is read-only for maintenance; nothing can be changed until it ends.")
{
    public MaintenanceState State { get; } = state;
}

/// <summary>The maintenance state could not be read: nothing leaves the CRM until it can (fail closed for external effects).</summary>
public sealed class MaintenanceStateUnavailableException(Exception inner)
    : Exception("The maintenance state could not be read; nothing is sent until it can.", inner);

/// <summary>Another maintenance decision was recorded after the one the operator saw.</summary>
public sealed class MaintenanceConflictException(MaintenanceState current)
    : Exception("Another maintenance decision was taken meanwhile; look at it before changing it.")
{
    public MaintenanceState Current { get; } = current;
}
