using System.Globalization;
using Crm.Identity.Contracts;
using Crm.Integrations.Core;
using Crm.Service.Contracts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Atera;

/// <summary>
/// Reads tickets and their conversations back from Atera (M39.2). One ticket's conversation is always read whole and applied as one
/// complete read; the ticket comes with it, so the mirror shows a change at once. Used by the conversation job and after an action.
/// </summary>
public sealed class AteraConversationReader(
    IAteraClient client, AteraTicketMirror mirror, IServiceApi service, ITechnicianDirectory technicians, ILogger<AteraConversationReader> logger)
{
    /// <summary>Errors of one ticket's read that say nothing about the others: Atera refused, timed out or answered something unreadable.</summary>
    public static bool IsReadFailure(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException or AteraApiException or TimeoutException or Polly.Timeout.TimeoutRejectedException or System.Text.Json.JsonException ||
        (ex is TaskCanceledException && !ct.IsCancellationRequested);

    /// <summary>Applies the conversation of every mirrored ticket of the batch; counts what changed and what could not be read.</summary>
    public async Task<(int Read, int Changed, int Unreadable)> ReadAsync(AteraTicketBatch batch, int maxConsecutiveFailures, CancellationToken ct)
    {
        int read = 0, changed = 0, unreadable = 0, consecutive = 0;
        foreach (var ticket in batch.Tickets)
        {
            IReadOnlyList<AteraComment> comments;
            try
            {
                comments = await client.GetTicketCommentsAsync(ticket.ExternalId, ct);
                consecutive = 0;
            }
            catch (Exception ex) when (IsReadFailure(ex, ct))
            {
                // The ticket keeps the conversation it had; the run is not complete, so the cursor waits for it.
                unreadable++;
                logger.LogWarning("The conversation of Atera ticket {TicketId} could not be read ({ErrorType})", ticket.ExternalId, ex.GetType().Name);
                if (++consecutive >= maxConsecutiveFailures)
                {
                    // Atera is down, not one ticket: stop instead of waiting out every remaining ticket.
                    break;
                }

                continue;
            }

            var result = await service.ApplyTicketConversationAsync(
                AteraTypes.System, ticket.ExternalId, await MapAsync(comments, ct), batch.Withheld.Contains(ticket.ExternalId), ct);
            read++;
            changed += result.Changed;
        }

        return (read, changed, unreadable);
    }

    /// <summary>
    /// After an action changed a ticket: reads the ticket (and its conversation when the action wrote one) back into the mirror. Best
    /// effort — the change is done at Atera, and when this read fails the next conversation read catches up.
    /// </summary>
    public async Task RefreshAsync(long ticketId, bool conversation, CancellationToken ct)
    {
        try
        {
            if (await client.GetTicketAsync(ticketId, ct) is not { } live)
            {
                return;
            }

            var batch = await mirror.MapAsync([live], ct);
            await service.UpsertTicketsAsync(batch.Tickets, ct);
            if (conversation)
            {
                await ReadAsync(batch, 1, ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Whatever failed here, the action itself is done: its outcome must not turn into "no clear answer" because of the read-back.
            logger.LogInformation("Atera ticket {TicketId} was changed but not read back ({ErrorType}); the next read shows it", ticketId, ex.GetType().Name);
        }
    }

    private async Task<IReadOnlyList<ExternalTicketComment>> MapAsync(IReadOnlyList<AteraComment> comments, CancellationToken ct)
    {
        var users = await technicians.ResolveAsync(
            comments.Where(c => c.Author == AteraCommentAuthor.Technician && (c.AuthorExternalId ?? c.AuthorEmail) is not null)
                .Select(c => new TechnicianRef(AteraTypes.System, c.AuthorExternalId ?? c.AuthorEmail!, c.AuthorEmail, c.AuthorName))
                .DistinctBy(t => t.ExternalId).ToList(),
            ct);
        return comments.Select(c => new ExternalTicketComment(
            c.CommentId, c.Text, c.IsInternal,
            c.Author switch { AteraCommentAuthor.Technician => TicketCommentAuthor.Technician, AteraCommentAuthor.EndUser => TicketCommentAuthor.EndUser, _ => TicketCommentAuthor.Unknown },
            c.AuthorName,
            c.Author == AteraCommentAuthor.Technician && (c.AuthorExternalId ?? c.AuthorEmail) is { } key && users.TryGetValue(key, out var user) ? user : null,
            c.CreatedAt)).ToList();
    }
}

/// <summary>
/// Keeps tickets' conversations in the CRM (M39.2, <c>atera-ticket-conversations</c>). Atera's list of tickets changed since the cursor
/// (<c>/tickets/lastmodified</c>) names what to read; open tickets whose conversation is older than
/// <see cref="AteraOptions.ConversationRefreshMinutes"/> are read again too, a few per run, because whether a new comment moves a
/// ticket's change time is not confirmed (EXT-03). The cursor moves only after a run that read every conversation it named.
/// </summary>
public sealed class AteraTicketConversationSyncJob(
    IAteraClient client,
    AteraTicketMirror mirror,
    AteraConversationReader conversations,
    IServiceApi service,
    SyncRunner runner,
    TimeProvider time,
    IOptions<AteraOptions> options,
    ILogger<AteraTicketConversationSyncJob> logger)
{
    public const string JobId = "atera-ticket-conversations";
    public const string CursorStream = "ticket-conversations";

    /// <summary>The list of changes is read from a little before the cursor: a change saved while the previous run read is not missed.</summary>
    private static readonly TimeSpan Overlap = TimeSpan.FromMinutes(5);

    private const int MaxConsecutiveFailures = 5;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Atera conversation sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(AteraTypes.System, JobId, async (progress, ct) =>
        {
            var started = time.GetUtcNow();
            var mapping = await mirror.SnapshotAsync(ct);
            var cursor = await runner.GetCursorAsync(AteraTypes.System, CursorStream, ct);
            var since = DateTimeOffset.TryParseExact(cursor, "O", CultureInfo.InvariantCulture, DateTimeStyles.None, out var at)
                ? at - Overlap
                : started.AddDays(-Math.Max(1, options.Value.ConversationBackfillDays));
            var tickets = new List<AteraTicket>();
            await foreach (var ticket in client.GetModifiedTicketsAsync(since, ct))
            {
                progress.Read++;
                tickets.Add(ticket);
            }

            var named = tickets.Select(t => t.TicketId).ToHashSet();
            var stale = await service.GetStaleConversationsAsync(
                AteraTypes.System, started.AddMinutes(-Math.Max(1, options.Value.ConversationRefreshMinutes)), Math.Max(1, options.Value.ConversationRefreshBatch), ct);
            foreach (var ticket in stale.Where(t => !named.Contains(t.ExternalId)))
            {
                try
                {
                    if (await client.GetTicketAsync(ticket.ExternalId, ct) is { } live)
                    {
                        tickets.Add(live);
                    }
                }
                catch (Exception ex) when (AteraConversationReader.IsReadFailure(ex, ct))
                {
                    progress.Failed++;
                    logger.LogWarning("Atera ticket {TicketId} could not be read again ({ErrorType})", ticket.ExternalId, ex.GetType().Name);
                }
            }

            var batch = await mapping.MapAsync(tickets, ct);
            var ticketChanges = await service.UpsertTicketsAsync(batch.Tickets, ct);
            var (read, changed, unreadable) = await conversations.ReadAsync(batch, MaxConsecutiveFailures, ct);
            progress.Failed += unreadable;
            progress.Changed = ticketChanges + changed;
            progress.Message = $"tickets changed in Atera {named.Count}, read again {tickets.Count - named.Count}, conversations read {read}, " +
                               $"ticket changes {ticketChanges}, comment changes {changed}, unreadable {unreadable}, skipped (customer not linked) {batch.Unlinked}";
            if (unreadable > 0 && read == 0)
            {
                throw new AteraApiException(System.Net.HttpStatusCode.BadGateway, "No ticket's conversation could be read.");
            }

            if (progress.Failed == 0)
            {
                await runner.SetCursorAsync(AteraTypes.System, CursorStream, started.ToString("O", CultureInfo.InvariantCulture), ct);
            }
        }, cancellationToken);
    }
}
