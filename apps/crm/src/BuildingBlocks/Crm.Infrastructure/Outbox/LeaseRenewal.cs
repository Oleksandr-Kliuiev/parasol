using Microsoft.Extensions.Logging;

namespace Crm.Infrastructure.Outbox;

/// <summary>
/// Keeps a lease while work runs (DEV-07): renews it every third of its length and cancels the work once the lease is lost
/// (another worker holds it now) or the host stops. A renewal that could not be written is retried at the next tick; only an
/// answer that the token no longer holds the lease counts as lost.
/// </summary>
public sealed class LeaseRenewal : IAsyncDisposable
{
    private readonly CancellationTokenSource _cancel;
    private readonly Task _loop;

    public LeaseRenewal(TimeSpan lease, TimeProvider timeProvider, Func<CancellationToken, Task<bool>> renew, ILogger logger, CancellationToken stopping)
    {
        _cancel = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        _loop = Task.Run(() => RenewAsync(lease / 3, timeProvider, renew, logger), CancellationToken.None);
    }

    /// <summary>Cancelled when the lease is lost or the host stops; the work under the lease runs with it.</summary>
    public CancellationToken Token => _cancel.Token;

    public bool Lost { get; private set; }

    private async Task RenewAsync(TimeSpan interval, TimeProvider timeProvider, Func<CancellationToken, Task<bool>> renew, ILogger logger)
    {
        try
        {
            using var timer = new PeriodicTimer(interval, timeProvider);
            while (await timer.WaitForNextTickAsync(_cancel.Token))
            {
                bool held;
                try
                {
                    held = await renew(_cancel.Token);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning("A lease could not be renewed ({ErrorType}); trying again at the next tick", ex.GetType().Name);
                    continue;
                }

                if (!held)
                {
                    Lost = true;
                    await _cancel.CancelAsync();
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Done, lost or stopping.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (!_cancel.IsCancellationRequested)
        {
            await _cancel.CancelAsync();
        }

        await _loop;
        _cancel.Dispose();
    }
}
