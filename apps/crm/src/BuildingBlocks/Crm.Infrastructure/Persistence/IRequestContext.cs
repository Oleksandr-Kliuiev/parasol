namespace Crm.Infrastructure.Persistence;

/// <summary>Ambient request information recorded in the audit log.</summary>
public interface IRequestContext
{
    string? IpAddress { get; }
    string? CorrelationId { get; }
}

public sealed class NullRequestContext : IRequestContext
{
    public string? IpAddress => null;
    public string? CorrelationId => System.Diagnostics.Activity.Current?.TraceId.ToString();
}
