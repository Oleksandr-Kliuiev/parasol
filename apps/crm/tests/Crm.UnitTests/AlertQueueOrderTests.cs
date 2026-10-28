using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;
using Crm.SharedKernel.Application;

namespace Crm.UnitTests;

/// <summary>
/// M38: the alert list's two orders, open (critical first, then the newest) and resolved, refuse each other's cursors, and the open
/// order refuses the cursors of its earlier, oldest-first form.
/// </summary>
public sealed class AlertQueueOrderTests
{
    [Fact]
    public void The_open_and_the_resolved_alert_lists_refuse_each_others_cursors()
    {
        var open = Stored(AlertSeverity.Warning);
        var resolved = Stored(AlertSeverity.Critical);
        resolved.Resolve(DateTimeOffset.Parse("2026-10-21T09:00:00Z"));

        var openCursor = AlertOrder.Cursor(open, resolved: false);
        (openCursor.SortKey, openCursor.Then).ShouldBe(("n1", open.CreatedAtSource.ToString("O")));
        AlertOrder.TryRead(openCursor, resolved: false, out var key).ShouldBeTrue();
        key.ShouldBe((1, open.CreatedAtSource));
        AlertOrder.TryRead(openCursor, resolved: true, out _).ShouldBeFalse();

        var resolvedCursor = AlertOrder.Cursor(resolved, resolved: true);
        resolvedCursor.SortKey.ShouldBe(resolved.ResolvedAt!.Value.ToString("O"));
        AlertOrder.TryRead(resolvedCursor, resolved: true, out var at).ShouldBeTrue();
        at.At.ShouldBe(resolved.ResolvedAt!.Value);
        AlertOrder.TryRead(resolvedCursor, resolved: false, out _).ShouldBeFalse();

        // The cursor of the order before M38 (newest first by the source's time) belongs to neither.
        var before = new KeysetCursor(open.CreatedAtSource.ToString("O"), open.Id);
        AlertOrder.TryRead(before, resolved: false, out _).ShouldBeFalse();
        AlertOrder.TryRead(new KeysetCursor("n7", open.Id, open.CreatedAtSource.ToString("O")), resolved: false, out _).ShouldBeFalse();
        // Nor does one of the oldest-first order (until 28.10.2026): its rank without the mark would page the new order wrongly.
        AlertOrder.TryRead(new KeysetCursor("1", open.Id, open.CreatedAtSource.ToString("O")), resolved: false, out _).ShouldBeFalse();
    }

    private static Alert Stored(AlertSeverity severity) => Crm.Service.Domain.Alert.Open("atera", AlertKind.Monitoring,
        new ExternalAlert("1", Guid.NewGuid(), severity, "Disk almost full", "SRV-01", DateTimeOffset.Parse("2026-10-21T06:00:00Z"), "900029"),
        null, DateTimeOffset.Parse("2026-10-21T07:00:00Z"));
}
