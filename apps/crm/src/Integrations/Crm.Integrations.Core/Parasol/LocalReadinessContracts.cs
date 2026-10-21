namespace Crm.Integrations.Core.Parasol;

public sealed record LocalReadinessView(string Status, DateTimeOffset CheckedAt, string Scope, string Connectivity,
    AdminLocalReadiness Admin);
public sealed record AdminLocalReadiness(string AuthMode, ProviderLocalReadiness Atera, ProviderLocalReadiness PowerOffice,
    GraphLocalReadiness MicrosoftGraph);
public sealed record ProviderLocalReadiness(bool Enabled, bool WriteEnabled, ProviderStoredState? Stored);
public sealed record ProviderStoredState(bool Paused, DateTimeOffset? LastSucceededAt, int Records, int UnlinkedRecords,
    int PendingOutbound, int FailedOutbound);
public sealed record GraphLocalReadiness(bool Enabled, bool CalendarEnabled, bool MailEnabled, bool SharePointEnabled,
    bool TeamsEnabled, GraphStoredState? Stored);
public sealed record GraphStoredState(DateTimeOffset? DirectoryLastSucceededAt, DateTimeOffset? RoleLastSucceededAt);

/// <summary>Only local flags cross the host boundary. Never credentials, endpoints or credential-presence checks.</summary>
public interface ILocalReadinessFlags
{
    LocalReadinessFlags Read();
}
public sealed record LocalReadinessFlags(string AuthMode, bool AteraEnabled, bool AteraWriteEnabled,
    bool PowerOfficeEnabled, bool PowerOfficeWriteEnabled, bool GraphEnabled, bool CalendarEnabled, bool MailEnabled,
    bool SharePointEnabled, bool TeamsEnabled);

internal sealed record LocalStoredState(ProviderStoredState Atera, ProviderStoredState PowerOffice, GraphStoredState Graph);
internal interface ILocalReadinessStoredState
{
    Task<LocalStoredState> ReadAsync(CancellationToken ct);
}
