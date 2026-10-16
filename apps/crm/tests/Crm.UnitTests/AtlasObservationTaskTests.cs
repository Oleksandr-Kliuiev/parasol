using Crm.Integrations.Core.Parasol;

namespace Crm.UnitTests;

public sealed class AtlasObservationTaskTests
{
    private static AtlasObservationSource Source()
    {
        var at = DateTimeOffset.Parse("2026-10-16T10:00:00Z");
        return new("READY", new(Guid.NewGuid(), new("workspace", "client"), Guid.NewGuid()),
            new("observation", "Synthetic source", "atera", "agent", "DISK_CAPACITY", "OPERATIONS", "HIGH", "URGENT",
                "INVESTIGATE", "OPEN", at, at, "CONFIRMED", "device"),
            [new("device", "Synthetic workstation", ["atera"])], "db");
    }

    [Fact]
    public void Review_fingerprint_tracks_binding_source_state_and_confirmed_device_but_not_unrelated_inventory()
    {
        var source = Source(); source.Sha256.Length.ShouldBe(64);
        (source with { Devices = [.. source.Devices!, new("unrelated", "Another workstation", ["atera"])] }).Sha256.ShouldBe(source.Sha256);
        (source with { Identity = source.Identity! with { LinkId = Guid.NewGuid() } }).Sha256.ShouldNotBe(source.Sha256);
        (source with { EmployeeId = Guid.NewGuid() }).Sha256.ShouldNotBe(source.Sha256);
        (source with { Observation = source.Observation! with { Status = "ACKNOWLEDGED" } }).Sha256.ShouldNotBe(source.Sha256);
        (source with { Observation = source.Observation! with { UpdatedAt = source.Observation.UpdatedAt.AddSeconds(1) } }).Sha256.ShouldNotBe(source.Sha256);
        (source with { Devices = [source.Devices![0] with { Hostname = "Renamed workstation" }] }).Sha256.ShouldNotBe(source.Sha256);
    }

    [Theory]
    [InlineData("abc-ABC._:123", true)][InlineData("..", false)][InlineData(".", false)][InlineData("", false)]
    [InlineData("a/b", false)][InlineData("a?url=other", false)][InlineData("a%2fb", false)][InlineData("\u0444", false)]
    public void Exact_observation_identifier_uses_the_Atlas_stored_identifier_vocabulary(string id, bool valid) =>
        AtlasObservationSource.ValidId(id).ShouldBe(valid);

    [Fact]
    public void Observation_identifier_length_is_bounded() => AtlasObservationSource.ValidId(new string('a', 101)).ShouldBeFalse();
}
