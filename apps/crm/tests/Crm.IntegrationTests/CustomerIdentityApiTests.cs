using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

// The rollback probe changes SQL trigger metadata; serialize this collection with other schema-administration tests.
[Collection(DatabaseAdministrationCollection.Name)]
public class CustomerIdentityApiTests(CrmWebFactory factory)
{
    private const string Import = "/api/v1/parasol/customer-identities/import";
    private static string Identity(Guid id) => $"/api/v1/parasol/customers/{id}/identity";
    private readonly string _userKey = $"parasol-{Guid.NewGuid():N}";
    private HttpClient Admin => factory.ClientAs(CrmRoles.Admin, userKey: _userKey);
    private async Task<Guid> Customer()
    {
        var response = await Admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization($"Identity {Guid.NewGuid():N} AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static CustomerIdentityImport Input(params Guid[] ids) => new(new(1, "atlas", $"test-{Guid.NewGuid():N}",
        ids.Select((_, i) => new AtlasIdentityClient($"client-{i}", $"Synthetic {i}")).ToArray()),
        ids.Select((id, i) => new CustomerIdentityMapping($"client-{i}", id)).ToArray());

    private async Task<CustomerIdentityPlan> Preview(CustomerIdentityImport input)
    {
        var response = await Admin.PostAsJsonAsync(Import, input);
        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        return (await response.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!;
    }
    private Task<HttpResponseMessage> Apply(CustomerIdentityImport input, string hash) =>
        Admin.PostAsJsonAsync($"{Import}?dryRun=false&expectedSha256={hash}", input);

    [Fact]
    public async Task Identity_operations_require_authentication_permissions_and_csrf()
    {
        (await factory.AnonymousClient().GetAsync(Identity(Guid.NewGuid()))).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        var input = Input(Guid.NewGuid());
        (await factory.AnonymousClient().PostAsJsonAsync(Import, input)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        (await factory.ClientAs(CrmRoles.Technician).PostAsJsonAsync(Import, input)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await factory.ClientAs(CrmRoles.Admin, csrf: false).PostAsJsonAsync(Import, input)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Shared_Atlas_export_previews_without_writes_then_applies_once_with_audit()
    {
        var id = await Customer();
        var snapshot = JsonSerializer.Deserialize<AtlasIdentitySnapshot>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "atlas-export.v1.example.json")), CustomerIdentityContract.JsonOptions)!;
        var input = new CustomerIdentityImport(snapshot, [new(snapshot.Clients[0].ClientId, id)]);
        var preview = await Preview(input);
        preview.DryRun.ShouldBeTrue(); preview.CanApply.ShouldBeTrue(); preview.Rows.Single().Outcome.ShouldBe("READY");
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(id)))!.Atlas.ShouldBeNull();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await db.ExternalRecords.AnyAsync(r => r.System == "Atlas" && r.ExternalId == CustomerIdentityContract.ExternalId(snapshot.WorkspaceId, snapshot.Clients[0].ClientId))).ShouldBeFalse();
        }
        (await Apply(input, "wrong")).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        var changed = input with { Snapshot = snapshot with { Clients = [snapshot.Clients[0] with { Name = "Changed" }] } };
        (await Apply(changed, preview.Sha256)).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        var applied = await Apply(input, preview.Sha256);
        applied.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await applied.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Rows.Single().Outcome.ShouldBe("APPLIED");
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(id))).ShouldBe(new(id, new(snapshot.WorkspaceId, snapshot.Clients[0].ClientId)));
        var repeated = await Apply(input, preview.Sha256);
        repeated.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await repeated.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Rows.Single().Outcome.ShouldBe("ALREADY_LINKED");
        using var auditScope = factory.Services.CreateScope();
        var auditDb = auditScope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var audit = await auditDb.AuditEntries.Where(a => a.EntityId == id && a.Action == "ParasolIdentityLinked").ToListAsync();
        audit.ShouldHaveSingleItem(); audit[0].UserId.ShouldNotBeNull();
        var details = audit[0].Changes; details.ShouldNotBeNull();
        details.ShouldContain(preview.Sha256); details.ShouldNotContain(snapshot.Clients[0].Name);
    }

    [Fact]
    public async Task A_conflict_rolls_back_the_entire_batch_and_never_remaps_a_customer()
    {
        var one = await Customer(); var two = await Customer(); var three = await Customer();
        var input = Input(one);
        (await Apply(input, (await Preview(input)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var conflicting = input with
        {
            Snapshot = input.Snapshot with { Clients = [input.Snapshot.Clients[0], new("new-client", "New")] },
            Mappings = [new("client-0", two), new("new-client", three)],
        };
        var preview = await Preview(conflicting);
        preview.CanApply.ShouldBeFalse(); preview.Rows.ShouldContain(r => r.Outcome == "ATLAS_ALREADY_LINKED");
        (await Apply(conflicting, preview.Sha256)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(three)))!.Atlas.ShouldBeNull();
        var differentWorkspace = Input(one);
        (await Preview(differentWorkspace)).Rows.Single().Outcome.ShouldBe("CUSTOMER_ALREADY_LINKED");
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(one)))!.Atlas!.WorkspaceId.ShouldBe(input.Snapshot.WorkspaceId);
    }

    [Fact]
    public async Task Unavailable_customers_are_reported_without_creating_a_link()
    {
        var input = Input(Guid.NewGuid());
        var plan = await Preview(input);
        plan.CanApply.ShouldBeFalse(); plan.Rows.Single().Outcome.ShouldBe("CUSTOMER_UNAVAILABLE");
        (await Apply(input, plan.Sha256)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await Admin.GetAsync(Identity(input.Mappings[0].CustomerId))).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Concurrent_confirmation_creates_one_link_and_one_audit_record()
    {
        var id = await Customer(); var input = Input(id); var preview = await Preview(input);
        var results = await Task.WhenAll(Apply(input, preview.Sha256), Apply(input, preview.Sha256));
        foreach (var r in results) r.StatusCode.ShouldBe(HttpStatusCode.OK);
        var outcomes = new List<string>();
        foreach (var r in results) outcomes.Add((await r.Content.ReadFromJsonAsync<CustomerIdentityPlan>())!.Rows.Single().Outcome);
        outcomes.Order().ToArray().ShouldBe(["ALREADY_LINKED", "APPLIED"]);
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        (await db.ExternalLinks.CountAsync(l => l.EntityId == id && l.System == "Atlas")).ShouldBe(1);
        (await db.AuditEntries.CountAsync(a => a.EntityId == id && a.Action == "ParasolIdentityLinked")).ShouldBe(1);
    }

    [Fact]
    public async Task A_partial_export_does_not_delete_or_mark_other_customers_gone()
    {
        var one = await Customer(); var two = await Customer(); var input = Input(one, two);
        (await Apply(input, (await Preview(input)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var partial = input with { Snapshot = input.Snapshot with { Clients = [input.Snapshot.Clients[0]] }, Mappings = [input.Mappings[0]] };
        (await Apply(partial, (await Preview(partial)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(two)))!.Atlas!.ClientId.ShouldBe("client-1");
    }

    [Fact]
    public async Task A_database_failure_after_writes_rolls_back_links_records_and_audit()
    {
        var one = await Customer(); var two = await Customer(); var input = Input(one, two);
        var preview = await Preview(input);
        var trigger = $"ParasolTest_{Guid.NewGuid():N}";
        await factory.AdminSqlAsync($"CREATE TRIGGER [audit].[{trigger}] ON [audit].[AuditEntries] AFTER INSERT AS BEGIN IF EXISTS (SELECT 1 FROM inserted WHERE EntityId = '{one}' AND Action = 'ParasolIdentityLinked') THROW 51001, 'Synthetic identity audit failure.', 1; END;");
        try
        {
            (await Apply(input, preview.Sha256)).StatusCode.ShouldBe(HttpStatusCode.InternalServerError);
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var keys = input.Mappings.Select(m => CustomerIdentityContract.ExternalId(input.Snapshot.WorkspaceId, m.AtlasClientId)).ToArray();
            (await db.ExternalLinks.CountAsync(l => l.System == "Atlas" && keys.Contains(l.ExternalId))).ShouldBe(0);
            (await db.ExternalRecords.CountAsync(r => r.System == "Atlas" && keys.Contains(r.ExternalId))).ShouldBe(0);
            (await db.AuditEntries.CountAsync(a => a.EntityId == one && a.Action == "ParasolIdentityLinked")).ShouldBe(0);
        }
        finally { await factory.AdminSqlAsync($"DROP TRIGGER [audit].[{trigger}];"); }
    }

    [Fact]
    public async Task Corrupted_registry_payload_never_resolves_to_a_different_Atlas_customer()
    {
        var id = await Customer(); var input = Input(id);
        (await Apply(input, (await Preview(input)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var key = CustomerIdentityContract.ExternalId(input.Snapshot.WorkspaceId, "client-0");
            var record = await db.ExternalRecords.SingleAsync(r => r.System == "Atlas" && r.ExternalId == key);
            record.Payload = """{"workspaceId":"foreign","clientId":"other"}""";
            await db.SaveChangesAsync();
        }
        var response = await Admin.GetAsync(Identity(id));
        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("PARASOL_IDENTITY_INCONSISTENT");
        var review = await Preview(input);
        review.CanApply.ShouldBeFalse(); review.Rows.Single().Outcome.ShouldBe("IDENTITY_INCONSISTENT");
        (await Apply(input, review.Sha256)).StatusCode.ShouldBe(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Explicit_unlink_is_audited_and_allows_a_new_reviewed_mapping()
    {
        var id = await Customer(); var input = Input(id);
        (await Apply(input, (await Preview(input)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        Guid linkId;
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            linkId = (await db.ExternalLinks.SingleAsync(l => l.EntityId == id && l.System == "Atlas")).Id;
        }
        (await Admin.DeleteAsync($"/api/v1/integrations/links/{linkId}")).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(id)))!.Atlas.ShouldBeNull();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            (await db.AuditEntries.CountAsync(a => a.EntityId == id && a.Action == "ParasolIdentityUnlinked")).ShouldBe(1);
        }
        var corrected = input with { Snapshot = input.Snapshot with { WorkspaceId = "corrected" } };
        (await Apply(corrected, (await Preview(corrected)).Sha256)).StatusCode.ShouldBe(HttpStatusCode.OK);
        // The old link ID cannot unlink a new binding (stale selection).
        (await Admin.DeleteAsync($"/api/v1/integrations/links/{linkId}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await Admin.GetFromJsonAsync<CustomerIdentityView>(Identity(id)))!.Atlas!.WorkspaceId.ShouldBe("corrected");
    }
}
