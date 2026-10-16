using System.Collections.Concurrent;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Microsoft.Extensions.Logging;

namespace Crm.IntegrationTests;

/// <summary>A test event with two handlers (DEV-07): each records its effect as an audit row in the customers module.</summary>
public sealed record DeliveryProbe(Guid ProbeId, string Note) : DomainEvent;

/// <summary>Switches for the probe handlers and a count of how often each one ran, per probe.</summary>
public sealed class DeliveryProbes
{
    public const string EffectA = "ProbeA";
    public const string EffectB = "ProbeB";

    private readonly ConcurrentDictionary<(Guid Probe, string Handler), int> _runs = new();
    private readonly ConcurrentDictionary<Guid, int> _failuresOfB = new();
    private readonly ConcurrentDictionary<Guid, TimeSpan> _pauseOfA = new();

    public int Runs(Guid probe, string handler) => _runs.GetValueOrDefault((probe, handler));

    /// <summary>Handler B fails the next <paramref name="times"/> deliveries of the probe.</summary>
    public void FailB(Guid probe, int times) => _failuresOfB[probe] = times;

    /// <summary>Handler A waits this long after saving its effect, inside its open transaction: a long handler.</summary>
    public void PauseA(Guid probe, TimeSpan pause) => _pauseOfA[probe] = pause;

    internal void Ran(Guid probe, string handler) => _runs.AddOrUpdate((probe, handler), 1, (_, runs) => runs + 1);

    internal bool BShouldFail(Guid probe)
    {
        while (_failuresOfB.TryGetValue(probe, out var left) && left > 0)
        {
            if (_failuresOfB.TryUpdate(probe, left - 1, left))
            {
                return true;
            }
        }

        return false;
    }

    internal TimeSpan PauseOfA(Guid probe) => _pauseOfA.GetValueOrDefault(probe);
}

public sealed class DeliveryProbeHandlerA(
    CustomersDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time, DeliveryProbes probes) : IDomainEventHandler<DeliveryProbe>
{
    public async Task HandleAsync(DeliveryProbe domainEvent, CancellationToken cancellationToken)
    {
        probes.Ran(domainEvent.ProbeId, DeliveryProbes.EffectA);
        db.RecordAudit(user, request, time, DeliveryProbes.EffectA, nameof(DeliveryProbe), domainEvent.ProbeId, null);
        await db.SaveChangesAsync(cancellationToken);
        if (probes.PauseOfA(domainEvent.ProbeId) is { } pause && pause > TimeSpan.Zero)
        {
            await Task.Delay(pause, cancellationToken);
        }
    }
}

public sealed class DeliveryProbeHandlerB(
    CustomersDbContext db, ICurrentUser user, IRequestContext request, TimeProvider time, DeliveryProbes probes) : IDomainEventHandler<DeliveryProbe>
{
    public async Task HandleAsync(DeliveryProbe domainEvent, CancellationToken cancellationToken)
    {
        probes.Ran(domainEvent.ProbeId, DeliveryProbes.EffectB);
        if (probes.BShouldFail(domainEvent.ProbeId))
        {
            throw new InvalidOperationException($"Probe B failed on purpose: {domainEvent.Note}");
        }

        db.RecordAudit(user, request, time, DeliveryProbes.EffectB, nameof(DeliveryProbe), domainEvent.ProbeId, null);
        await db.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>A test event whose handler tries to change two modules (DEV-07: refused, nothing of it is kept).</summary>
public sealed record CrossModuleProbe(Guid ProbeId) : DomainEvent;

public sealed class CrossModuleProbeHandler(
    CustomersDbContext customers, Crm.Sales.Persistence.SalesDbContext sales, ICurrentUser user, IRequestContext request, TimeProvider time)
    : IDomainEventHandler<CrossModuleProbe>
{
    public async Task HandleAsync(CrossModuleProbe domainEvent, CancellationToken cancellationToken)
    {
        customers.RecordAudit(user, request, time, "ProbeCustomers", nameof(CrossModuleProbe), domainEvent.ProbeId, null);
        await customers.SaveChangesAsync(cancellationToken);
        sales.RecordAudit(user, request, time, "ProbeSales", nameof(CrossModuleProbe), domainEvent.ProbeId, null);
        await sales.SaveChangesAsync(cancellationToken);
    }
}

/// <summary>Keeps every line a logger writes, with its structured values and exception, as a log workspace would.</summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    public ConcurrentQueue<string> Lines { get; } = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        var values = state is IEnumerable<KeyValuePair<string, object?>> pairs ? string.Join(';', pairs.Select(p => $"{p.Key}={p.Value}")) : string.Empty;
        Lines.Enqueue($"{logLevel}: {formatter(state, exception)} [{values}] {exception}");
    }
}
