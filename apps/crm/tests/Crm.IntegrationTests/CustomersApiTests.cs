using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Outbox;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public class CustomersApiTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";

    [Fact]
    public async Task Anonymous_requests_are_rejected()
    {
        var response = await factory.AnonymousClient().GetAsync(Organizations);
        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Bff_user_returns_roles_and_permissions()
    {
        var user = await factory.ClientAs(CrmRoles.Sales).GetFromJsonAsync<JsonElement>("/bff/user");

        user.GetProperty("roles").EnumerateArray().Select(r => r.GetString()).ShouldBe([CrmRoles.Sales]);
        var permissions = user.GetProperty("permissions").EnumerateArray().Select(p => p.GetString()).ToList();
        permissions.ShouldContain(Permissions.CustomersWrite);
        permissions.ShouldNotContain(Permissions.FinanceCostRead);
    }

    [Fact]
    public async Task Sales_creates_organization_with_audit_trail_and_outbox_event()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var orgNumber = TestData.OrgNumber();

        var response = await sales.PostAsJsonAsync(Organizations, TestData.Organization("Audit Test AS", orgNumber));

        response.StatusCode.ShouldBe(HttpStatusCode.Created);
        response.Headers.ETag.ShouldNotBeNull();
        var created = await response.Content.ReadFromJsonAsync<JsonElement>();
        var id = created.GetProperty("id").GetGuid();
        created.GetProperty("orgNumber").GetString().ShouldBe(orgNumber);
        created.GetProperty("status").GetString().ShouldBe("Prospect");

        var audit = await factory.ClientAs(CrmRoles.Admin).GetFromJsonAsync<JsonElement>($"/api/v1/audit?entityId={id}");
        var entry = audit.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        entry.GetProperty("action").GetString().ShouldBe("Create");
        entry.GetProperty("userName").GetString().ShouldBe("Test crm.sales");
        entry.GetProperty("changes").GetProperty("OrgNumber").GetProperty("new").GetString().ShouldBe(orgNumber);
        entry.GetProperty("changes").GetProperty("Status").GetProperty("new").GetString().ShouldBe("Prospect");
        entry.GetProperty("changes").TryGetProperty("IsDeleted", out _).ShouldBeFalse();

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        (await db.OutboxMessages.CountAsync(m => m.Payload.Contains(id.ToString()))).ShouldBe(1);
    }

    [Fact]
    public async Task Outbox_processor_dispatches_events_to_handlers()
    {
        var response = await factory.ClientAs(CrmRoles.Sales).PostAsJsonAsync(Organizations, TestData.Organization("Outbox Test AS"));
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        // Test classes run in parallel and drain the same outbox: when another processor has claimed the message, this one
        // skips it until that dispatch is done, so a single pass proves nothing either way.
        var processor = ActivatorUtilities.CreateInstance<OutboxProcessor>(factory.Services);
        async Task<DateTimeOffset?> ProcessedAtAsync()
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            return (await db.OutboxMessages.SingleAsync(m => m.Payload.Contains(id.ToString()), TestContext.Current.CancellationToken)).ProcessedAt;
        }

        for (var attempt = 0; attempt < 20 && await ProcessedAtAsync() is null; attempt++)
        {
            await processor.ProcessContextAsync(typeof(CustomersDbContext), TestContext.Current.CancellationToken);
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }

        (await ProcessedAtAsync()).ShouldNotBeNull();
        factory.Events.Received.ShouldContain(e => e.OrganizationId == id);
    }

    [Fact]
    public async Task State_changing_request_without_csrf_header_is_rejected()
    {
        var response = await factory.ClientAs(CrmRoles.Admin, csrf: false).PostAsJsonAsync(Organizations, TestData.Organization("No CSRF AS"));

        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("CSRF_HEADER_REQUIRED");
    }

    [Fact]
    public async Task Technician_cannot_create_organizations()
    {
        var response = await factory.ClientAs(CrmRoles.Technician).PostAsJsonAsync(Organizations, TestData.Organization("Forbidden AS"));
        response.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Duplicate_org_number_is_a_conflict_pointing_to_existing_record()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var orgNumber = TestData.OrgNumber();
        var first = await (await sales.PostAsJsonAsync(Organizations, TestData.Organization("Original AS", orgNumber)))
            .Content.ReadFromJsonAsync<JsonElement>();

        var response = await sales.PostAsJsonAsync(Organizations, TestData.Organization("Copy AS", orgNumber));

        response.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("code").GetString().ShouldBe("CUS_DUPLICATE_ORGNR");
        problem.GetProperty("existingId").GetGuid().ShouldBe(first.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task Invalid_org_number_fails_validation()
    {
        var response = await factory.ClientAs(CrmRoles.Sales).PostAsJsonAsync(Organizations, TestData.Organization("Bad Number AS", "923609017"));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync()).ShouldContain("OrgNumber");
    }

    [Fact]
    public async Task Update_requires_current_etag()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var created = await sales.PostAsJsonAsync(Organizations, TestData.Organization("Concurrency AS"));
        var etag = created.Headers.ETag!.Tag;
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var url = $"{Organizations}/{id}";
        var body = TestData.Organization("Concurrency Renamed AS");

        (await sales.PutAsJsonAsync(url, body)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);

        var first = new HttpRequestMessage(HttpMethod.Put, url) { Content = JsonContent.Create(body) };
        first.Headers.IfMatch.ParseAdd(etag);
        var updated = await sales.SendAsync(first);
        updated.StatusCode.ShouldBe(HttpStatusCode.OK);
        updated.Headers.ETag!.Tag.ShouldNotBe(etag);

        var stale = new HttpRequestMessage(HttpMethod.Put, url) { Content = JsonContent.Create(TestData.Organization("Lost Update AS")) };
        stale.Headers.IfMatch.ParseAdd(etag);
        var conflict = await sales.SendAsync(stale);
        conflict.StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        (await conflict.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().ShouldBe("CONCURRENCY_CONFLICT");
    }

    [Fact]
    public async Task Etag_from_get_can_be_used_to_update()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var created = await sales.PostAsJsonAsync(Organizations, TestData.Organization("Read Then Edit AS"));
        var url = $"{Organizations}/{(await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid()}";

        var read = await sales.GetAsync(url);
        var etag = read.Headers.ETag!.Tag;
        etag.ShouldNotBe("\"0\"");

        var update = new HttpRequestMessage(HttpMethod.Put, url) { Content = JsonContent.Create(TestData.Organization("Read Then Edit AS", status: "Customer")) };
        update.Headers.IfMatch.ParseAdd(etag);
        var response = await sales.SendAsync(update);

        response.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString().ShouldBe("Customer");
    }

    [Fact]
    public async Task List_supports_search_and_cursor_paging()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var marker = $"Paging {Guid.NewGuid():N}"[..20];
        foreach (var suffix in new[] { "A", "B", "C" })
        {
            (await sales.PostAsJsonAsync(Organizations, TestData.Organization($"{marker} {suffix} AS"))).EnsureSuccessStatusCode();
        }

        var page1 = await sales.GetFromJsonAsync<JsonElement>($"{Organizations}?search={Uri.EscapeDataString(marker)}&limit=2");
        page1.GetProperty("items").GetArrayLength().ShouldBe(2);
        // The total is the whole filter's, not the page's (DEV-12): the list's status filters show it.
        page1.GetProperty("totalCount").GetInt32().ShouldBe(3);
        var cursor = page1.GetProperty("nextCursor").GetString();
        cursor.ShouldNotBeNullOrEmpty();

        var page2 = await sales.GetFromJsonAsync<JsonElement>($"{Organizations}?search={Uri.EscapeDataString(marker)}&limit=2&cursor={cursor}");
        var last = page2.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        last.GetProperty("name").GetString().ShouldBe($"{marker} C AS");
        page2.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
        page2.GetProperty("totalCount").GetInt32().ShouldBe(3);
    }

    [Fact]
    public async Task Search_by_org_number_prefix()
    {
        var sales = factory.ClientAs(CrmRoles.Sales);
        var orgNumber = TestData.OrgNumber();
        (await sales.PostAsJsonAsync(Organizations, TestData.Organization("Prefix Search AS", orgNumber))).EnsureSuccessStatusCode();

        var result = await sales.GetFromJsonAsync<JsonElement>($"{Organizations}?search={orgNumber[..3]}%20{orgNumber[3..]}");

        result.GetProperty("items").EnumerateArray().ShouldContain(i => i.GetProperty("orgNumber").GetString() == orgNumber);
    }

    [Fact]
    public async Task Soft_deleted_organization_frees_its_org_number()
    {
        var management = factory.ClientAs(CrmRoles.Management);
        var orgNumber = TestData.OrgNumber();
        var created = await (await management.PostAsJsonAsync(Organizations, TestData.Organization("To Delete AS", orgNumber)))
            .Content.ReadFromJsonAsync<JsonElement>();
        var url = $"{Organizations}/{created.GetProperty("id").GetGuid()}";

        (await factory.ClientAs(CrmRoles.Sales).DeleteAsync(url)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await management.DeleteAsync(url)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await management.GetAsync(url)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await management.PostAsJsonAsync(Organizations, TestData.Organization("Reborn AS", orgNumber))).StatusCode.ShouldBe(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Api_endpoints_all_require_a_permission()
    {
        // Endpoints that authorize by other means (own user, per-record checks) or intentionally only need sign-in.
        string[] allowed =
        [
            "/api/v1/identity/me/preferences", "/api/v1/identity/me/my-day-layout", "/api/v1/search", "/api/v1/audit/entities/{module}/{entityType}/{entityId:guid}", "/api/{**path}",
            // Notifications belong to the signed-in user and authorize by ownership.
            "/api/v1/notifications/", "/api/v1/notifications/{id:guid}/read", "/api/v1/notifications/read-all", "/api/v1/notifications/preferences",
        ];
        var dataSource = factory.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>();

        var unprotected = dataSource.Endpoints
            .OfType<Microsoft.AspNetCore.Routing.RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText?.StartsWith("/api", StringComparison.Ordinal) == true)
            .Where(e => !allowed.Contains(e.RoutePattern.RawText))
            .Where(e => !e.Metadata.OfType<Microsoft.AspNetCore.Authorization.IAuthorizeData>().Any(a => a.Policy?.StartsWith("perm:", StringComparison.Ordinal) == true))
            .Select(e => e.RoutePattern.RawText)
            .ToList();

        unprotected.ShouldBeEmpty();
        _ = factory.Services.GetRequiredService<ModuleDbContextRegistry>();
    }
}
