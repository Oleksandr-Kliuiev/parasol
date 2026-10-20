using System.Text.Json;
using System.Text.Json.Nodes;
using Crm.Integrations.Core.Parasol;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.UnitTests;

public sealed class AtlasDeviceObservationTests
{
    private static readonly AtlasCustomerReference Reference = new("synthetic-workspace", "synthetic-client");
    private static readonly AtlasObservationSelection Selection = new(AtlasQueueSeverity.ALL, AtlasQueueStatus.ACTIVE, "device-one");
    private static JsonNode Context() => JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-context.v1.example.json")))!;
    private static AtlasObservationQueuePage Read(string? entityId = "device-one", bool linked = true)
    {
        var context = Context();
        if (!linked) context["links"] = new JsonArray();
        var page = context["observations"]!.DeepClone();
        var row = page["items"]![0]!.DeepClone(); row["entityId"] = entityId;
        page["items"] = new JsonArray(row); page["total"] = 1; page["truncated"] = false; page["nextCursor"] = null;
        foreach (var severity in AtlasProjectionJson.Severities) page["counts"]![severity] = severity == row["severity"]!.GetValue<string>() ? 1 : 0;
        using var overview = JsonDocument.Parse(context.ToJsonString()); using var document = JsonDocument.Parse(page.ToJsonString());
        return AtlasObservationQueueProjection.Read(document.RootElement, Reference, Selection,
            AtlasDeviceProjection.Read(overview.RootElement, Reference), null);
    }

    [Fact]
    public void Device_ids_stay_exact_and_bounded_while_missing_selection_keeps_the_complete_queue()
    {
        AtlasObservationSelection.Parse(null, null)!.DeviceId.ShouldBeNull();
        AtlasObservationSelection.Parse(null, null, "pc:one/with space")!.DeviceId.ShouldBe("pc:one/with space");
        AtlasObservationSelection.Parse(null, null, new string('x', 256)).ShouldNotBeNull();
        foreach (var value in new[] { "", "  ", "one\n", "one\u007f", "one\u0085", "pc-\ud800", "pc-\udc00", new string('x', 257) })
        {
            AtlasObservationSelection.Parse(null, null, value).ShouldBeNull();
            (Selection with { DeviceId = value }).IsValid.ShouldBeFalse();
        }
    }

    [Fact]
    public void A_selected_device_page_preserves_its_verified_current_association() =>
        Read().Items.Single().DeviceId.ShouldBe("device-one");

    [Theory]
    [InlineData(null)]
    [InlineData("device-two")]
    public void A_mixed_or_unresolved_page_is_rejected_instead_of_locally_hiding_rows(string? entityId) =>
        Should.Throw<JsonException>(() => Read(entityId));

    [Fact]
    public void History_keeps_the_stored_association_without_disclosing_an_unconfirmed_row_device_id()
    {
        var row = Read(linked: false).Items.Single();
        row.DeviceStatus.ShouldBe("UNAVAILABLE"); row.DeviceId.ShouldBeNull();
        JsonSerializer.Serialize(row).ShouldNotContain("device-one");
    }

    [Fact]
    public void Protected_continuation_cannot_change_devices_or_turn_into_the_complete_queue()
    {
        var service = new AtlasObservationCursor(new EphemeralDataProtectionProvider(), TimeProvider.System);
        var employee = Guid.NewGuid(); var identity = new CustomerIdentityView(Guid.NewGuid(), Reference, Guid.NewGuid());
        var cursor = service.Protect(employee, identity, Selection, "source_cursor");
        service.TryRead(cursor, employee, identity, Selection, out var source).ShouldBeTrue(); source.ShouldBe("source_cursor");
        foreach (var deviceId in new string?[] { null, "device-two", "Device-one" })
        {
            service.TryRead(cursor, employee, identity, Selection with { DeviceId = deviceId }, out _).ShouldBeFalse();
            service.TryRead(cursor, employee, identity with { LinkId = Guid.NewGuid() }, Selection with { DeviceId = deviceId },
                out _, out var identityChanged).ShouldBeFalse(); identityChanged.ShouldBeFalse();
        }
        var complete = Selection with { DeviceId = null };
        service.TryRead(service.Protect(employee, identity, complete, "source_cursor"), employee, identity, Selection, out _).ShouldBeFalse();
        var unicode = Selection with { DeviceId = new string('ø', 256) };
        var bounded = service.Protect(employee, identity, unicode, "source_cursor");
        bounded.Length.ShouldBeLessThanOrEqualTo(2048);
        service.TryRead(bounded, employee, identity, unicode, out _).ShouldBeTrue();
    }
}
