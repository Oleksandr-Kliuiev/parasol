namespace Crm.Integrations.Atera;

/// <summary>Agents (devices) and alerts.</summary>
internal sealed partial class AteraClient
{
    public IAsyncEnumerable<AteraAgent> GetAgentsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("agents", ReadAgent, cancellationToken);

    /// <summary>
    /// The alert mirror resolves what a complete read no longer lists (M38), so this read must not lose anything quietly: the
    /// previous page is read again for alerts that moved across the boundary, and an alert without an id fails the read.
    /// </summary>
    public IAsyncEnumerable<AteraAlert> GetAlertsAsync(string? status, CancellationToken cancellationToken) =>
        GetPagedAsync("alerts", ReadAlert, cancellationToken, status is null ? null : $"alertStatus={Uri.EscapeDataString(status)}", a => a.AlertId, strict: true);
}
