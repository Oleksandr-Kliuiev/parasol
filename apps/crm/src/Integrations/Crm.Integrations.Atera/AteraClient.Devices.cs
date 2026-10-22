namespace Crm.Integrations.Atera;

/// <summary>Agents (devices) and alerts.</summary>
internal sealed partial class AteraClient
{
    /// <summary>
    /// The device mirror marks removed what a read no longer lists, and the machines and coverage gaps (M40) stand on it, so this
    /// read must not lose anything quietly either: the previous page is read again, and an agent without an id or a customer fails
    /// the read.
    /// </summary>
    public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("agents", ReadAgent, cancellationToken, key: a => a.AgentId, strict: true);

    /// <summary>
    /// The alert mirror resolves what a complete read no longer lists (M38), so this read must not lose anything quietly: the
    /// previous page is read again for alerts that moved across the boundary, and an alert without an id fails the read.
    /// </summary>
    public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("alerts", ReadAlert, cancellationToken, status is null ? null : $"alertStatus={Uri.EscapeDataString(status)}", a => a.AlertId, strict: true);
}
