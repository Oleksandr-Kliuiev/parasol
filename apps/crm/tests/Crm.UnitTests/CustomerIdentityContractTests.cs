using System.Text.Json;
using Crm.Integrations.Core.Parasol;

namespace Crm.UnitTests;

public class CustomerIdentityContractTests
{
    private static readonly Guid First = Guid.Parse("11111111-1111-4111-8111-111111111111");
    private static readonly Guid Second = Guid.Parse("22222222-2222-4222-8222-222222222222");
    private static CustomerIdentityImport Input() => new(new(1, "atlas", "workspace", [new("one", "One"), new("two", "Two")]),
        [new("one", First), new("two", Second)]);

    [Fact]
    public void Consumes_the_same_contract_fixture_as_the_Atlas_HTTP_test()
    {
        var snapshot = JsonSerializer.Deserialize<AtlasIdentitySnapshot>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-export.v1.example.json")), CustomerIdentityContract.JsonOptions)!;
        snapshot.Source.ShouldBe("atlas");
        CustomerIdentityContract.Validate(new(snapshot, [new(snapshot.Clients[0].ClientId, First)])).ShouldBeNull();
    }

    [Fact]
    public void Rejects_ambiguous_missing_or_malformed_identity_input()
    {
        var good = Input();
        CustomerIdentityImport[] invalid =
        [
            good with { Snapshot = good.Snapshot with { SchemaVersion = 2 } },
            good with { Snapshot = good.Snapshot with { Source = "crm" } },
            good with { Snapshot = good.Snapshot with { WorkspaceId = "" } },
            good with { Snapshot = good.Snapshot with { Clients = [new("one", "One"), new("one", "Duplicate")] } },
            good with { Mappings = [new("one", First), new("one", Second)] },
            good with { Mappings = [new("one", First), new("two", First)] },
            good with { Mappings = [new("missing", First)] },
            good with { Mappings = [new("one", Guid.Empty)] },
            good with { Mappings = [] },
            good with { Snapshot = null! },
            good with { Mappings = null! },
        ];
        foreach (var input in invalid)
        {
            var error = CustomerIdentityContract.Validate(input);
            error.ShouldNotBeNull(); error.Code.ShouldBe("PARASOL_IDENTITY_INVALID");
        }
    }

    [Fact]
    public void Approval_binds_every_identity_and_name_but_not_input_order()
    {
        var input = Input();
        var hash = CustomerIdentityContract.PlanHash(input);
        CustomerIdentityContract.PlanHash(input with { Snapshot = input.Snapshot with { Clients = input.Snapshot.Clients.Reverse().ToArray() },
            Mappings = input.Mappings.Reverse().ToArray() }).ShouldBe(hash);
        CustomerIdentityContract.PlanHash(input with { Snapshot = input.Snapshot with { WorkspaceId = "other" } }).ShouldNotBe(hash);
        CustomerIdentityContract.PlanHash(input with { Snapshot = input.Snapshot with { Clients = [new("one", "Renamed"), new("two", "Two")] } }).ShouldNotBe(hash);
        CustomerIdentityContract.PlanHash(input with { Mappings = [new("one", Second), new("two", First)] }).ShouldNotBe(hash);
    }

    [Fact]
    public void External_keys_preserve_workspace_boundaries_without_separator_ambiguity()
    {
        CustomerIdentityContract.ExternalId("a:b", "c").ShouldNotBe(CustomerIdentityContract.ExternalId("a", "b:c"));
        CustomerIdentityContract.ExternalId("one", "client").ShouldNotBe(CustomerIdentityContract.ExternalId("two", "client"));
        CustomerIdentityContract.ExternalId("one", "client").Length.ShouldBe(64);
    }

    [Fact]
    public void Undeclared_payload_fields_are_rejected_instead_of_becoming_stored_credentials()
    {
        Should.Throw<JsonException>(() => JsonSerializer.Deserialize<AtlasIdentitySnapshot>(
            """{"schemaVersion":1,"source":"atlas","workspaceId":"one","clients":[],"accessToken":"synthetic-only"}""",
            CustomerIdentityContract.JsonOptions));
    }
}
