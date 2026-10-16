using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Crm.Integrations.Core;

/// <summary>An administrator asked for a connection test; crm-worker, which holds the provider credentials, answers it.</summary>
public sealed record IntegrationConnectionTestRequested(string System, Guid RunId) : DomainEvent;

/// <summary>Where a connection test stands: queued or running (<c>Running</c>), <c>Succeeded</c> or <c>Failed</c>.</summary>
public sealed record ConnectionTestStatus(
    Guid? Id, string System, string Status, bool? Success, string? Message, DateTimeOffset? RequestedAt, DateTimeOffset? FinishedAt)
{
    internal static ConnectionTestStatus From(SyncRun run) => new(
        run.Id,
        run.System,
        run.Status.ToString(),
        run.Status switch { SyncRunStatus.Succeeded => true, SyncRunStatus.Failed => false, _ => null },
        SafeMessage(run.System, run.Status, run.Message),
        run.StartedAt,
        run.FinishedAt);

    internal static string? SafeMessage(string system, SyncRunStatus status, string? message) => status switch
    {
        SyncRunStatus.Succeeded => system switch
        {
            "atera" => "Connected to Atera.",
            "partnercenter" => "Connected to Partner Center.",
            // Preserve the environment only from these exact, application-authored strings.
            "poweroffice" when message is "Connected to PowerOffice Go (Demo)." or "Connected to PowerOffice Go (Production)." => message,
            "poweroffice" => "Connected to PowerOffice.",
            _ => "Connection succeeded.",
        },
        SyncRunStatus.Failed => "Connection test failed. Review configuration and provider availability.",
        _ => null,
    };
}

/// <summary>
/// Runs a connection test in crm-worker. Provider credentials reach only the worker (DEV-04-AC05, docs/runbooks/08), so
/// crm-web records the request as a sync run of job <see cref="Job"/> and the outbox brings it here; the run then says how it
/// went. A test is answered once: a repeated delivery finds the run finished and leaves it.
/// </summary>
internal sealed class IntegrationConnectionTestHandler(
    IEnumerable<IIntegrationAdapter> adapters,
    IntegrationDbContext db,
    TimeProvider time,
    ILogger<IntegrationConnectionTestHandler> logger) : IDomainEventHandler<IntegrationConnectionTestRequested>
{
    public const string Job = "connection-test";

    public async Task HandleAsync(IntegrationConnectionTestRequested domainEvent, CancellationToken cancellationToken)
    {
        var run = await db.SyncRuns.SingleOrDefaultAsync(r => r.Id == domainEvent.RunId && r.Job == Job, cancellationToken);
        if (run is not { Status: SyncRunStatus.Running })
        {
            return;
        }

        ConnectionTestResult result;
        if (adapters.SingleOrDefault(a => a.System == domainEvent.System) is not { } adapter)
        {
            result = new ConnectionTestResult(false, $"Unknown system '{domainEvent.System}'.");
        }
        else
        {
            try
            {
                result = await adapter.TestConnectionAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning("Connection test of {System} failed ({ErrorType})", domainEvent.System, ex.GetType().Name);
                result = new ConnectionTestResult(false, "Connection test failed.");
            }
        }

        run.Status = result.Success ? SyncRunStatus.Succeeded : SyncRunStatus.Failed;
        run.Message = ConnectionTestStatus.SafeMessage(run.System, run.Status, result.Message);
        run.FinishedAt = time.GetUtcNow();
        await db.SaveChangesAsync(cancellationToken);
    }
}
