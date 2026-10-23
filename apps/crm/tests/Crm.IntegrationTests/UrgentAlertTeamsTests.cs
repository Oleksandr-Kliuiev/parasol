using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Persistence;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Features;
using Crm.Notifications.Persistence;
using Crm.Service.Contracts;
using Crm.Service.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: an alert that becomes urgent leaves an event in the transaction that stored it; Notifications queues one notice
/// per alert and Norwegian day for the operations channel, ids and codes only, and the channel job words the card when it sends it —
/// and posts nothing about an alert that is no longer urgent by then. Each test reads under a system of its own: a complete read
/// resolves every other open alert of its system, and other tests mirror "atera". Other classes run the event processor and the
/// channel job at the same time, so every check narrows to this test's alerts.
/// </summary>
public sealed class UrgentAlertTeamsTests(CrmWebFactory factory)
{
    private const string Channel = "/teams/operations";
    private static readonly DateTimeOffset At = new(2026, 10, 21, 8, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_alert_that_becomes_urgent_is_posted_once_to_the_operations_channel_with_its_customer_and_source()
    {
        var (system, organizationId, marker) = await ScenarioAsync();
        await ApplyAsync(Complete(system, Source(marker, "c1", organizationId), Source(marker, "w1", organizationId, AlertSeverity.Warning)));
        var critical = await AlertIdAsync(system, "c1");
        (await EventsAsync(critical)).Count.ShouldBe(1);
        (await EventsAsync(await AlertIdAsync(system, "w1"))).ShouldBeEmpty("a warning is not urgent");

        // A read that lists the alert again while it is urgent already announces nothing more.
        await ApplyAsync(Complete(system, Source(marker, "c1", organizationId), Source(marker, "w1", organizationId, AlertSeverity.Warning)));
        (await EventsAsync(critical)).Count.ShouldBe(1);

        await factory.ProcessEventsAsync();
        var post = (await PostsAsync(critical)).ShouldHaveSingleItem();
        (post.Kind, post.Channel, post.CardJson).ShouldBe((ChannelPostKind.UrgentAlert, TeamsChannel.Operations, "{}"));
        // Ids and codes (the test's system code carries its marker), never the source's words.
        post.ParametersJson.ShouldNotBeNull().ShouldNotContain("disk full");
        post.ParametersJson.ShouldNotContain("SRV-01");
        post.Parameters["alertId"].ShouldBe(critical.ToString("D"));
        post.Parameters["organizationId"].ShouldBe(organizationId.ToString("D"));

        await factory.SendChannelPostsUntilAsync(async () => (await PostsAsync(critical)).TrueForAll(p => p.Status != ChannelPostStatus.Pending));
        var card = Cards(marker).ShouldHaveSingleItem();
        card.Title.ShouldBe($"Kritisk driftsvarsel for {marker} Varsel AS");
        card.Text.ShouldBe($"{marker} disk full");
        card.Facts.ShouldBe([("Kilde", system), ("Enhet", "SRV-01"), ("Åpnet", "21.10.2026 10:00")]);
        (await PostsAsync(critical)).ShouldHaveSingleItem().Status.ShouldBe(ChannelPostStatus.Sent);

        // The event comes again (the worker stopped before acknowledging it): the receipt and the notice's key keep the card single.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().OutboxMessages
                .Where(m => m.Type.Contains(nameof(AlertBecameUrgent)) && m.Payload.Contains(critical.ToString()))
                .ExecuteUpdateAsync(s => s
                    .SetProperty(m => m.Status, OutboxStatus.Processing)
                    .SetProperty(m => m.ProcessedAt, (DateTimeOffset?)null)
                    .SetProperty(m => m.DeliveredHandlers, (string?)null)
                    .SetProperty(m => m.LockedUntil, DateTimeOffset.UtcNow.AddMinutes(-1)), Ct);
        }

        await factory.ProcessEventsAsync();
        await factory.SendChannelPostsUntilAsync(async () => (await PostsAsync(critical)).TrueForAll(p => p.Status != ChannelPostStatus.Pending));
        (await PostsAsync(critical)).Count.ShouldBe(1);
        Cards(marker).Count.ShouldBe(1);
    }

    [Fact]
    public async Task An_alert_no_longer_urgent_when_its_event_comes_is_not_queued_and_one_that_flaps_is_queued_once_a_day()
    {
        var (system, organizationId, marker) = await ScenarioAsync();

        // An event that arrives after its alert closed (late, or out of order): the handler reads the alert again and queues nothing.
        // The alert is a warning, so no event of its own is handled while it is open; the late event is put in the outbox here.
        await ApplyAsync(Complete(system, Source(marker, "late", organizationId, AlertSeverity.Warning)));
        await ApplyAsync(Complete(system));
        var late = await AlertIdAsync(system, "late");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ServiceDbContext>();
            db.OutboxMessages.Add(OutboxMessage.For(new AlertBecameUrgent(late), DateTimeOffset.UtcNow, null));
            await db.SaveChangesAsync(Ct);
        }

        await factory.ProcessEventsAsync();
        (await EventsAsync(late)).ShouldHaveSingleItem().Status.ShouldBe(OutboxStatus.Processed);
        (await PostsAsync(late)).ShouldBeEmpty("the alert was resolved when its event was handled");

        // Open, closed and open again the same day: two events, one notice for the day.
        var open = Complete(system, Source(marker, "flap", organizationId));
        await ApplyAsync(open);
        await factory.ProcessEventsAsync();
        await ApplyAsync(Complete(system));
        await ApplyAsync(open);
        await factory.ProcessEventsAsync();
        var flapping = await AlertIdAsync(system, "flap");
        var events = await EventsAsync(flapping);
        events.Count.ShouldBe(2);
        events.ShouldAllBe(m => m.Status == OutboxStatus.Processed);
        (await PostsAsync(flapping)).Count.ShouldBe(1);
    }

    [Fact]
    public async Task A_notice_whose_alert_is_no_longer_urgent_when_its_turn_comes_is_skipped_and_nothing_is_posted()
    {
        var (system, organizationId, marker) = await ScenarioAsync();

        // A notice queued while the alert was urgent waits for the job; meanwhile the alert closed. The alert here is a warning that
        // closed and the notice is queued directly, so no other class's job can post anything about it while it is open.
        await ApplyAsync(Complete(system, Source(marker, "gone", organizationId, AlertSeverity.Warning)));
        await ApplyAsync(Complete(system));
        var alert = await AlertIdAsync(system, "gone");
        var notice = ChannelPost.Notice(TeamsChannel.Operations, ChannelPostKind.UrgentAlert,
            new Dictionary<string, string> { ["alertId"] = alert.ToString("D"), ["organizationId"] = organizationId.ToString("D"), ["system"] = system },
            $"urgent-alert:{alert:N}:test-skipped", DateTimeOffset.UtcNow);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<NotificationsDbContext>();
            db.ChannelPosts.Add(notice);
            await db.SaveChangesAsync(Ct);
        }

        await factory.SendChannelPostsUntilAsync(async () => (await PostsAsync(alert)).TrueForAll(p => p.Status != ChannelPostStatus.Pending));
        var skipped = (await PostsAsync(alert)).ShouldHaveSingleItem();
        skipped.Status.ShouldBe(ChannelPostStatus.Skipped);
        skipped.LastError.ShouldNotBeNull().ShouldContain("no longer urgent");
        skipped.DedupeKey.ShouldBeNull("a notice that sent no card gives its day back: the alert may still be posted if it turns urgent again");
        Cards(marker).ShouldBeEmpty();
    }

    private async Task<(string System, Guid OrganizationId, string Marker)> ScenarioAsync()
    {
        var marker = $"M43{Guid.NewGuid():N}"[..11];
        var organizationId = await factory.ClientAs(CrmRoles.Admin).CreateOrganizationAsync(new { name = $"{marker} Varsel AS", status = "Customer" });
        return ($"m43-{marker}", organizationId, marker);
    }

    private static ExternalAlert Source(
        string marker, string id, Guid organizationId, AlertSeverity severity = AlertSeverity.Critical, string? title = null) =>
        new(id, organizationId, severity, title ?? $"{marker} disk full", "SRV-01", At, "501");

    private static AlertSnapshot Complete(string system, params IReadOnlyCollection<ExternalAlert> alerts) =>
        new(system, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true);

    private async Task ApplyAsync(AlertSnapshot snapshot)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<IServiceApi>().ApplyAlertSnapshotAsync(snapshot, Ct)).Applied.ShouldBeTrue();
    }

    private async Task<Guid> AlertIdAsync(string system, string externalId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().Alerts.AsNoTracking()
            .Where(a => a.System == system && a.ExternalId == externalId).Select(a => a.Id).SingleAsync(Ct);
    }

    /// <summary>The events about one alert in the Service module's outbox.</summary>
    private async Task<List<OutboxMessage>> EventsAsync(Guid alertId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<ServiceDbContext>().OutboxMessages.AsNoTracking()
            .Where(m => m.Type.Contains(nameof(AlertBecameUrgent)) && m.Payload.Contains(alertId.ToString())).ToListAsync(Ct);
    }

    /// <summary>The notices about one alert, whatever their day (a skipped one gave its day's key back, so they are found by the alert).</summary>
    private async Task<List<ChannelPost>> PostsAsync(Guid alertId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var id = alertId.ToString("D");
        return await scope.ServiceProvider.GetRequiredService<NotificationsDbContext>().ChannelPosts.AsNoTracking()
            .Where(p => p.Kind == ChannelPostKind.UrgentAlert && p.ParametersJson != null && p.ParametersJson.Contains(id)).ToListAsync(Ct);
    }

    /// <summary>The cards the operations channel received about this test's customer, read from the adaptive card.</summary>
    private List<(string Title, string Text, List<(string, string)> Facts)> Cards(string marker) =>
        [.. factory.Graph.LogEntries
            .Select(e => e.RequestMessage)
            .Where(r => r!.Path == Channel && r.Method == "POST" && (r.Body ?? string.Empty).Contains(marker, StringComparison.Ordinal))
            .Select(r =>
            {
                using var json = JsonDocument.Parse(r!.Body!);
                var body = json.RootElement.GetProperty("attachments")[0].GetProperty("content").GetProperty("body");
                var facts = body.EnumerateArray().Where(b => b.GetProperty("type").GetString() == "FactSet")
                    .SelectMany(b => b.GetProperty("facts").EnumerateArray())
                    .Select(f => (f.GetProperty("title").GetString()!, f.GetProperty("value").GetString()!)).ToList();
                return (body[0].GetProperty("text").GetString()!, body[1].GetProperty("text").GetString()!, facts);
            })];
}
