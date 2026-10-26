using System.Net;
using System.Text;
using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Features;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>
/// M38: an alert keeps its id from one read to the next, a complete read resolves what it no longer lists, and a read that may
/// have missed something changes nothing. Synthetic data only.
/// </summary>
public sealed class AlertLifecycleTests
{
    private const string System = "atera";
    private static readonly Guid Customer = Guid.Parse("11111111-0000-0000-0000-000000000001");
    private static readonly Guid OtherCustomer = Guid.Parse("11111111-0000-0000-0000-000000000002");
    private static readonly DateTimeOffset First = DateTimeOffset.Parse("2026-10-21T08:00:00Z");
    private static readonly AlertDeviceIndex NoDevices = new([]);

    [Fact]
    public void A_new_alert_opens_and_the_next_read_keeps_the_same_alert()
    {
        var (added, opened) = Apply(Complete([Source("1")]), [], First);
        opened.ShouldBe(new AlertSnapshotResult(true, 1, 0, 0, 0));
        var alert = added.ShouldHaveSingleItem();
        (alert.State, alert.LastSeenAt, alert.ResolvedAt, alert.Kind).ShouldBe((AlertState.Open, First, null, AlertKind.Monitoring));
        (alert.ExternalCustomerId, alert.Url).ShouldBe(("501", "https://atera.example/alerts/1"));

        var (again, seen) = Apply(Complete([Source("1")]), [alert], First.AddMinutes(30));
        again.ShouldBeEmpty();
        seen.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 0), "a refreshed last-seen time alone is not a change");
        alert.LastSeenAt.ShouldBe(First.AddMinutes(30));
        alert.State.ShouldBe(AlertState.Open);
    }

    [Fact]
    public void A_complete_read_resolves_an_alert_it_no_longer_lists_and_a_later_read_opens_the_same_alert_again()
    {
        var alert = Stored("1");
        var (_, resolved) = Apply(Complete([]), [alert], First.AddHours(1));
        resolved.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 1));
        (alert.State, alert.ResolvedAt).ShouldBe((AlertState.Resolved, (DateTimeOffset?)First.AddHours(1)));
        Apply(Complete([]), [alert], First.AddHours(2)).Result.Resolved.ShouldBe(0, "resolved once");
        alert.ResolvedAt.ShouldBe(First.AddHours(1));

        var (added, reopened) = Apply(Complete([Source("1", title: "Disk almost full again")]), [alert], First.AddHours(3));
        added.ShouldBeEmpty();
        reopened.ShouldBe(new AlertSnapshotResult(true, 0, 1, 0, 0));
        (alert.State, alert.ResolvedAt, alert.LastSeenAt, alert.Title).ShouldBe((AlertState.Open, null, First.AddHours(3), "Disk almost full again"));
    }

    [Fact]
    public void An_incomplete_read_changes_nothing_at_all()
    {
        var listed = Stored("1");
        var missing = Stored("2");
        var (added, result) = Apply(new AlertSnapshot(System, AlertKind.Monitoring, [Source("1", title: "Changed"), Source("3")], ["1", "3"], IsComplete: false),
            [listed, missing], First.AddHours(1));
        result.ShouldBe(AlertSnapshotResult.NotApplied);
        result.Changed.ShouldBe(0);
        added.ShouldBeEmpty();
        foreach (var alert in new[] { listed, missing })
        {
            (alert.State, alert.LastSeenAt, alert.ResolvedAt, alert.Title).ShouldBe((AlertState.Open, First, null, "Disk almost full"));
        }
    }

    [Fact]
    public void An_alert_the_source_still_reports_open_but_the_read_could_not_map_is_left_exactly_as_it_is()
    {
        // Its customer lost the link to the organization: the read lists it among the open ids, not among the mapped alerts.
        var unlinked = Stored("1");
        var (_, result) = Apply(new AlertSnapshot(System, AlertKind.Monitoring, [], ["1"], IsComplete: true), [unlinked], First.AddHours(1));
        result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 0, 0));
        (unlinked.State, unlinked.LastSeenAt, unlinked.OrganizationId).ShouldBe((AlertState.Open, (DateTimeOffset?)First, Customer));
    }

    [Fact]
    public void A_read_resolves_only_alerts_of_its_own_kind()
    {
        var security = Alert.Open(System, AlertKind.Security, Source("9"), null, First);
        Apply(Complete([]), [security], First.AddHours(1)).Result.Resolved.ShouldBe(0);
        security.State.ShouldBe(AlertState.Open);
    }

    [Fact]
    public void A_changed_field_is_counted_once_and_an_alert_moves_with_its_customer()
    {
        var alert = Stored("1");
        var (_, result) = Apply(Complete([Source("1", organizationId: OtherCustomer, severity: AlertSeverity.Warning)]), [alert], First.AddMinutes(30));
        result.ShouldBe(new AlertSnapshotResult(true, 0, 0, 1, 0));
        (alert.OrganizationId, alert.Severity).ShouldBe((OtherCustomer, AlertSeverity.Warning));
        Apply(Complete([Source("1", organizationId: OtherCustomer, severity: AlertSeverity.Warning)]), [alert], First.AddMinutes(60)).Result.Changed.ShouldBe(0);
    }

    [Fact]
    public void An_alert_listed_twice_in_one_read_is_stored_once()
    {
        var (added, result) = Apply(Complete([Source("1"), Source("1", title: "Second copy")]), [], First);
        added.ShouldHaveSingleItem().Title.ShouldBe("Disk almost full");
        result.Opened.ShouldBe(1);
    }

    [Fact]
    public void A_device_counts_only_when_exactly_one_current_device_of_the_customer_carries_the_name()
    {
        var unique = Guid.NewGuid();
        var index = new AlertDeviceIndex([
            new(unique, Customer, "SRV-01"),
            new(Guid.NewGuid(), Customer, "PC-SAME"),
            new(Guid.NewGuid(), Customer, "pc-same "),
            new(Guid.NewGuid(), OtherCustomer, "LAPTOP-7"),
            new(Guid.NewGuid(), Customer, "   "),
        ]);

        index.Find(Customer, "srv-01").ShouldBe(unique, "case does not matter");
        index.Find(Customer, " SRV-01 ").ShouldBe(unique);
        index.Find(Customer, "PC-SAME").ShouldBeNull("two devices carry the name");
        index.Find(Customer, "LAPTOP-7").ShouldBeNull("the device belongs to another customer");
        index.Find(Customer, "UNKNOWN").ShouldBeNull();
        index.Find(Customer, null).ShouldBeNull();
        index.Find(Customer, "  ").ShouldBeNull();
    }

    [Fact]
    public void The_device_link_follows_the_devices_on_every_read()
    {
        var device = Guid.NewGuid();
        var (added, _) = Apply(Complete([Source("1", deviceName: "srv-01")]), [], First, new AlertDeviceIndex([new(device, Customer, "SRV-01")]));
        var alert = added.ShouldHaveSingleItem();
        alert.DeviceId.ShouldBe(device);

        var ambiguous = new AlertDeviceIndex([new(device, Customer, "SRV-01"), new(Guid.NewGuid(), Customer, "Srv-01")]);
        Apply(Complete([Source("1", deviceName: "srv-01")]), [alert], First.AddMinutes(30), ambiguous).Result.Updated.ShouldBe(1);
        alert.DeviceId.ShouldBeNull();
    }

    [Fact]
    public void Long_text_is_cut_to_its_column_and_a_link_that_does_not_fit_is_left_out()
    {
        var alert = Alert.Open(System, AlertKind.Monitoring,
            Source("1", title: new string('t', 600), deviceName: new string('d', 300), url: "https://atera.example/" + new string('u', 600)), null, First);
        (alert.Title.Length, alert.DeviceName!.Length, alert.Url).ShouldBe((Alert.TitleLength, Alert.DeviceNameLength, null));
    }

    [Fact]
    public async Task The_atera_alert_read_reads_the_previous_page_again_and_catches_an_alert_that_moved_up()
    {
        // Page 1 is read; then alert A closes, so C moves from page 2 onto page 1 before page 2 is read.
        var requests = 0;
        var client = Client(request =>
        {
            var page = QueryValue(request.RequestUri!, "page");
            requests++;
            return page == "1" && requests == 1 ? Page(2, "A", "B") : page == "1" ? Page(2, "B", "C") : Page(2, "D", "E");
        });

        var ids = await ReadAsync(client);
        ids.Order(StringComparer.Ordinal).ShouldBe(["A", "B", "C", "D", "E"]);
        requests.ShouldBe(3, "page 1, page 2, page 1 again");
    }

    [Fact]
    public async Task An_atera_alert_without_an_id_fails_the_read_instead_of_disappearing_from_it()
    {
        var client = Client(_ => Response("""{"items":[{"AlertID":"A","Severity":"Critical"},{"Title":"No id"}],"totalPages":1}"""));
        await Should.ThrowAsync<AteraApiException>(() => ReadAsync(client));
    }

    private static (IReadOnlyList<Alert> Added, AlertSnapshotResult Result) Apply(
        AlertSnapshot snapshot, IReadOnlyCollection<Alert> stored, DateTimeOffset now, AlertDeviceIndex? devices = null) =>
        AlertSnapshotRules.Apply(snapshot, stored, devices ?? NoDevices, now);

    private static AlertSnapshot Complete(IReadOnlyCollection<ExternalAlert> alerts) =>
        new(System, AlertKind.Monitoring, alerts, alerts.Select(a => a.ExternalId).ToList(), IsComplete: true);

    private static Alert Stored(string id) => Alert.Open(System, AlertKind.Monitoring, Source(id), null, First);

    private static ExternalAlert Source(
        string id, string title = "Disk almost full", Guid? organizationId = null, AlertSeverity severity = AlertSeverity.Critical,
        string? deviceName = "SRV-01", string? url = null) =>
        new(id, organizationId ?? Customer, severity, title, deviceName, DateTimeOffset.Parse("2026-10-21T06:00:00Z"), "501",
            url ?? $"https://atera.example/alerts/{id}");

    private static async Task<List<string>> ReadAsync(AteraClient client)
    {
        var ids = new List<string>();
        await foreach (var alert in client.GetAlertsAsync("Open", TestContext.Current.CancellationToken))
        {
            ids.Add(alert.AlertId);
        }

        return ids;
    }

    private static AteraClient Client(Func<HttpRequestMessage, HttpResponseMessage> answer) =>
        new(new HttpClient(new Stub(answer)) { BaseAddress = new Uri("https://atera.example/api/v3/") },
            Options.Create(new AteraOptions { ItemsInPage = 2 }));

    private static HttpResponseMessage Page(int totalPages, params string[] ids) =>
        Response(JsonSerializer.Serialize(new { items = ids.Select(id => new { AlertID = id, CustomerID = 501, Severity = "Warning", Title = id }), totalPages }));

    private static HttpResponseMessage Response(string json) =>
        new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static string? QueryValue(Uri uri, string name) =>
        uri.Query.TrimStart('?').Split('&').Select(pair => pair.Split('=', 2)).Where(pair => pair[0] == name).Select(pair => pair[1]).FirstOrDefault();

    private sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request));
    }
}
