using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Sales.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-09: record scope in the Restricted mode, the default. A salesperson sees and works on the quotes they own, a technician
/// the projects they are on; lists, ids, documents, transitions, lookups from other modules and the report follow it, and a
/// record outside the scope answers exactly like one that does not exist.
/// </summary>
public class RecordScopeTests(CrmWebFactory factory)
{
    private const string Sales = "/api/v1/sales";
    private const string Projects = "/api/v1/projects";
    private static readonly DateOnly Today = DateOnly.FromDateTime(
        TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).DateTime);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_a_salesperson_gets_no_other_salespersons_quote_by_id_filter_or_action()
    {
        var marker = $"S{Guid.NewGuid():N}"[..10];
        var a = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-a-{marker}");
        var b = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-b-{marker}");
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(a, marker);
        var quoteId = await QuoteDocumentsTests.QuoteAsync(a, organizationId, contactId, $"{marker}A", "nb");
        (await a.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var etag = await EtagAsync(a, $"{Sales}/quotes/{quoteId}");

        // By id: exactly the answer for an id that does not exist, and no document.
        var missing = await b.GetAsync($"{Sales}/quotes/{Guid.NewGuid()}", Ct);
        var hidden = await b.GetAsync($"{Sales}/quotes/{quoteId}", Ct);
        hidden.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await hidden.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe((await missing.ReadJsonAsync()).GetProperty("code").GetString());
        (await b.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        // No filter widens the list: not mine=false, not the organization, not the search.
        foreach (var query in new[] { $"search={marker}", $"search={marker}&mine=false", $"organizationId={organizationId}", $"organizationId={organizationId}&status=Ready" })
        {
            (await b.GetFromJsonAsync<JsonElement>($"{Sales}/quotes?{query}", Ct)).GetArrayLength().ShouldBe(0, query);
        }

        // Every action on it: not found, and nothing changes.
        (await b.PutWithETagAsync($"{Sales}/quotes/{quoteId}", new { organizationId, title = "Tatt over", termMonths = 12 }, etag))
            .StatusCode.ShouldBe(HttpStatusCode.NotFound);
        foreach (var action in new[] { "submit", "withdraw", "accept", "cancel", "revise" })
        {
            (await b.PostAsync($"{Sales}/quotes/{quoteId}/{action}", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound, action);
        }

        (await b.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/decline", new { reason = "Nei" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await b.PostAsJsonAsync($"{Sales}/quotes/{quoteId}/send", new { toAddress = "kunde@example.no" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await b.PostWithETagAsync($"{Sales}/quotes/{quoteId}/transfer", new { ownerId = await b.UserIdAsync() }, etag))
            .StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var untouched = await a.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}", Ct);
        untouched.GetProperty("status").GetString().ShouldBe("Ready");
        untouched.GetProperty("etag").GetString().ShouldBe(etag);

        // Nor is the owner field a way in: B can neither create a quote for A nor make A the owner of B's own quote.
        var aId = await a.UserIdAsync();
        var forA = await b.PostAsJsonAsync($"{Sales}/quotes", new { organizationId, title = $"{marker} for A", termMonths = 12, ownerId = aId }, Ct);
        forA.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await forA.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_OWNER_NOT_ALLOWED");
        var ownId = await QuoteDocumentsTests.QuoteAsync(b, organizationId, contactId, $"{marker}B", "nb");
        var giveAway = await b.PutWithETagAsync(
            $"{Sales}/quotes/{ownId}", new { organizationId, title = $"{marker}B Drift", termMonths = 12, ownerId = aId }, await EtagAsync(b, $"{Sales}/quotes/{ownId}"));
        giveAway.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await giveAway.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_OWNER_NOT_ALLOWED");

        // A sees its own quote only; management and finance see both.
        (await IdsAsync(a, $"{Sales}/quotes?search={marker}")).ShouldBe([quoteId]);
        foreach (var role in new[] { CrmRoles.Management, CrmRoles.Finance })
        {
            (await IdsAsync(factory.ClientAs(role, userKey: $"scope-{role}"), $"{Sales}/quotes?search={marker}")).Order().ShouldBe(new[] { quoteId, ownId }.Order());
        }

        // The switch: opened, every holder of sales.read sees every quote again — and the user is told.
        await using var open = factory.WithWebHostBuilder(builder => builder.UseSetting("Authorization:RecordScope", "Open"));
        using var bOpen = QuoteDocumentsTests.Client(open, CrmRoles.Sales, $"scope-b-{marker}");
        (await bOpen.GetAsync($"{Sales}/quotes/{quoteId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var scope = (await bOpen.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("recordScope");
        scope.GetProperty("mode").GetString().ShouldBe("Open");
        scope.GetProperty("allQuotes").GetBoolean().ShouldBeTrue();
    }

    [Fact]
    public async Task AC02_a_technician_sees_the_projects_they_are_on_and_no_filter_widens_that()
    {
        var marker = $"T{Guid.NewGuid():N}"[..10];
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "scope-admin");
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "scope-lead");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-tech-{marker}");
        var colleague = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-tech2-{marker}");
        var technicianId = await technician.UserIdAsync();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Drift AS", status = "Customer" });

        var managed = await ProjectAsync(lead, organizationId, $"{marker} Ledet", technicianId);
        var member = await ProjectAsync(lead, organizationId, $"{marker} Medlem", null);
        (await lead.PostAsJsonAsync($"{Projects}/{member}/members", new { userId = technicianId }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var tasked = await ProjectAsync(lead, organizationId, $"{marker} Oppgave", null);
        await TaskForAsync(lead, tasked, technicianId);
        var other = await ProjectAsync(lead, organizationId, $"{marker} Annen", await colleague.UserIdAsync());

        // The list holds the three, whatever the filters say; a filter only narrows within the scope.
        (await IdsAsync(technician, $"{Projects}?search={marker}")).Order().ShouldBe(new[] { managed, member, tasked }.Order());
        (await IdsAsync(technician, $"{Projects}?search={marker}&managerId={await colleague.UserIdAsync()}")).ShouldBeEmpty();
        (await IdsAsync(technician, $"{Projects}?organizationId={organizationId}&openOnly=true")).Order().ShouldBe(new[] { managed, member, tasked }.Order());

        // By id: like a project that does not exist.
        var hidden = await technician.GetAsync($"{Projects}/{other}", Ct);
        hidden.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await hidden.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRJ_NOT_FOUND");
        (await technician.GetAsync($"{Projects}/{managed}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Hours go only on a project one is on, of the entry's customer, still open.
        var refused = await BookAsync(technician, organizationId, other);
        refused.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("TIM_PROJECT_NOT_AVAILABLE");
        var booked = await BookAsync(technician, organizationId, member);
        booked.StatusCode.ShouldBe(HttpStatusCode.Created, await booked.Content.ReadAsStringAsync(Ct));
        (await booked.ReadJsonAsync()).GetProperty("projectName").GetString().ShouldBe($"{marker} Medlem");
        var elsewhere = await admin.CreateOrganizationAsync(new { name = $"{marker} Annen kunde AS", status = "Customer" });
        var foreign = await ProjectAsync(lead, elsewhere, $"{marker} Annen kunde", technicianId);
        (await (await BookAsync(technician, organizationId, foreign)).ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("TIM_PROJECT_OTHER_ORGANIZATION");
        (await lead.PostAsJsonAsync($"{Projects}/{tasked}/status", new { status = "Cancelled" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await (await BookAsync(technician, organizationId, tasked)).ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("TIM_PROJECT_CLOSED");

        // Every other role sees all of them.
        foreach (var role in new[] { CrmRoles.Sales, CrmRoles.ServiceLead, CrmRoles.Finance, CrmRoles.ReadOnly, CrmRoles.Management })
        {
            (await IdsAsync(factory.ClientAs(role, userKey: $"scope-{role}"), $"{Projects}?search={marker}")).Count.ShouldBe(5, role);
        }
    }

    [Fact]
    public async Task AC03_search_documents_counts_history_and_custom_fields_do_not_go_around_the_scope()
    {
        var marker = $"C{Guid.NewGuid():N}"[..10];
        var a = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-a-{marker}");
        var b = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-b-{marker}");
        var technician = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-tech-{marker}");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "scope-management");
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(a, marker);
        var quoteId = await QuoteDocumentsTests.QuoteAsync(a, organizationId, contactId, marker, "nb");
        var number = (await a.GetFromJsonAsync<JsonElement>($"{Sales}/quotes/{quoteId}", Ct)).GetProperty("number").GetString()!;
        var projectId = await ProjectAsync(factory.ClientAs(CrmRoles.ServiceLead, userKey: "scope-lead"), organizationId, $"{marker} Prosjekt", null);

        // Global search has no quote or project results at all: their numbers and names turn up nowhere.
        foreach (var (client, term) in new[] { (b, number), (b, marker), (technician, marker), (technician, $"{marker} Prosjekt") })
        {
            var found = await client.GetFromJsonAsync<JsonElement>($"/api/v1/search?q={Uri.EscapeDataString(term)}", Ct);
            found.GetProperty("groups").EnumerateArray().SelectMany(g => g.GetProperty("items").EnumerateArray())
                .ShouldNotContain(item => item.GetProperty("url").GetString()!.Contains("/quotes/") || item.GetProperty("url").GetString()!.Contains("/projects/"));
        }

        // Counts and sums: lists and their totals hold only what is in scope; the dashboard carries no quote or project figures.
        (await b.GetFromJsonAsync<JsonElement>($"{Sales}/quotes?organizationId={organizationId}", Ct)).GetArrayLength().ShouldBe(0);
        (await technician.GetFromJsonAsync<JsonElement>($"{Projects}?organizationId={organizationId}", Ct)).GetArrayLength().ShouldBe(0);
        (await b.GetStringAsync("/api/v1/reports/dashboard", Ct)).ShouldNotContain(number);

        // History of quotes and projects needs audit.read — roles that see every record — even for the owner.
        (await a.GetAsync($"/api/v1/audit/entities/sales/Quote/{quoteId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await b.GetAsync($"/api/v1/audit/entities/sales/Quote/{quoteId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await technician.GetAsync($"/api/v1/audit/entities/projects/Project/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var history = await management.GetFromJsonAsync<JsonElement>($"/api/v1/audit/entities/sales/Quote/{quoteId}", Ct);
        history.GetProperty("items").GetArrayLength().ShouldBeGreaterThan(0);

        // Custom fields cannot hang on a quote or a project.
        (await a.GetAsync($"/api/v1/custom-fields/Quote/{quoteId}", Ct)).IsSuccessStatusCode.ShouldBeFalse();
        (await technician.GetAsync($"/api/v1/custom-fields/Project/{projectId}", Ct)).IsSuccessStatusCode.ShouldBeFalse();

        // Whole-table exports and the access report are not for limited roles.
        (await b.GetAsync("/api/v1/reports/mart/time-entries", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await b.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await technician.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task AC04_handing_over_a_quote_or_a_project_moves_access_at_once_and_saved_links_go_dead()
    {
        var marker = $"H{Guid.NewGuid():N}"[..10];
        var a = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-a-{marker}");
        var b = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-b-{marker}");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "scope-management");
        var bId = await b.UserIdAsync();
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(a, marker);
        var first = await QuoteDocumentsTests.QuoteAsync(a, organizationId, contactId, marker, "nb");
        (await a.PostAsync($"{Sales}/quotes/{first}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var second = (await (await a.PostAsync($"{Sales}/quotes/{first}/revise", null, Ct)).ReadJsonAsync()).GetProperty("id").GetGuid();

        // Only the current version is handed over, with the current ETag, to an active user.
        var old = await a.TransferQuoteAsync(first, bId);
        old.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await old.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_NOT_CURRENT");
        (await a.PostAsJsonAsync($"{Sales}/quotes/{second}/transfer", new { ownerId = bId }, Ct)).StatusCode.ShouldBe(HttpStatusCode.PreconditionRequired);
        var stale = await EtagAsync(a, $"{Sales}/quotes/{second}");
        (await a.PutWithETagAsync($"{Sales}/quotes/{second}", new { organizationId, title = $"{marker} Drift v2", termMonths = 12 }, stale)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await a.PostWithETagAsync($"{Sales}/quotes/{second}/transfer", new { ownerId = bId }, stale)).StatusCode.ShouldBe(HttpStatusCode.PreconditionFailed);
        var unknown = await a.TransferQuoteAsync(second, Guid.NewGuid());
        unknown.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await unknown.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("SAL_QUOTE_OWNER_UNKNOWN");
        (await a.TransferQuoteAsync(second, bId)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        // A's saved links are dead at once; B has the whole quote, both versions.
        foreach (var id in new[] { first, second })
        {
            (await a.GetAsync($"{Sales}/quotes/{id}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
            var seen = await b.GetAsync($"{Sales}/quotes/{id}", Ct);
            seen.StatusCode.ShouldBe(HttpStatusCode.OK);
            // Nothing a browser or proxy could hand to the next user of the machine.
            seen.Headers.CacheControl!.NoStore.ShouldBeTrue();
        }

        (await IdsAsync(a, $"{Sales}/quotes?search={marker}")).ShouldBeEmpty();
        (await IdsAsync(b, $"{Sales}/quotes?search={marker}")).Order().ShouldBe(new[] { first, second }.Order());

        // The audit log keeps who handed it to whom.
        var history = await management.GetStringAsync($"/api/v1/audit/entities/sales/Quote/{second}", Ct);
        history.ShouldContain("OwnerId");
        history.ShouldContain(bId.ToString());

        // A project: the manager handed over, a member taken off — access follows at once.
        var lead = factory.ClientAs(CrmRoles.ServiceLead, userKey: "scope-lead");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "scope-admin");
        var t1 = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-t1-{marker}");
        var t2 = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-t2-{marker}");
        var t3 = factory.ClientAs(CrmRoles.Technician, userKey: $"scope-t3-{marker}");
        var customer = await admin.CreateOrganizationAsync(new { name = $"{marker} Prosjekt AS", status = "Customer" });
        var projectId = await ProjectAsync(lead, customer, $"{marker} Prosjekt", await t1.UserIdAsync());
        (await lead.PostAsJsonAsync($"{Projects}/{projectId}/members", new { userId = await t2.UserIdAsync() }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await lead.PostAsJsonAsync($"{Projects}/{projectId}/members", new { userId = await t2.UserIdAsync() }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await t1.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await t2.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await t3.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);

        var project = await lead.GetFromJsonAsync<JsonElement>($"{Projects}/{projectId}", Ct);
        project.GetProperty("members").EnumerateArray().Single().GetProperty("id").GetGuid().ShouldBe(await t2.UserIdAsync());
        (await lead.PutWithETagAsync($"{Projects}/{projectId}", new
        {
            organizationId = customer,
            name = $"{marker} Prosjekt",
            type = "Other",
            billingModel = "TimeAndMaterial",
            managerId = await t3.UserIdAsync(),
            startDate = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            budgetHours = 10m,
            budgetAmount = 0m,
        }, project.GetProperty("etag").GetString()!)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await t1.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await t3.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await lead.DeleteAsync($"{Projects}/{projectId}/members/{await t2.UserIdAsync()}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await t2.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await management.GetStringAsync($"/api/v1/audit/entities/projects/ProjectMember/{await MemberRowAsync(projectId, await t2.UserIdAsync())}", Ct))
            .ShouldContain("Delete");
    }

    [Fact]
    public async Task AC05_finance_and_management_keep_their_access_and_nothing_in_a_request_sets_a_role()
    {
        var marker = $"F{Guid.NewGuid():N}"[..10];
        var a = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-a-{marker}");
        var b = factory.ClientAs(CrmRoles.Sales, userKey: $"scope-b-{marker}");
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "scope-finance");
        var management = factory.ClientAs(CrmRoles.Management, userKey: "scope-management");
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "scope-admin");
        var (organizationId, contactId) = await QuoteDocumentsTests.CustomerAsync(a, marker);
        var quoteId = await QuoteDocumentsTests.QuoteAsync(a, organizationId, contactId, marker, "nb");
        (await a.PostAsync($"{Sales}/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var orphan = await QuoteDocumentsTests.QuoteAsync(a, organizationId, contactId, $"{marker}O", "nb");
        // As older data may hold it: a quote nobody owns. It is not handed to everyone to fill the gap.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<SalesDbContext>().Quotes.Where(q => q.Id == orphan)
                .ExecuteUpdateAsync(s => s.SetProperty(q => q.OwnerId, (Guid?)null), Ct);
        }

        var projectId = await ProjectAsync(factory.ClientAs(CrmRoles.ServiceLead, userKey: "scope-lead"), organizationId, $"{marker} Uten folk", null);

        // Finance reads every quote and project and downloads documents; it writes neither.
        (await finance.GetAsync($"{Sales}/quotes/{orphan}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.GetAsync($"{Sales}/quotes/{quoteId}/pdf", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.PostAsync($"{Sales}/quotes/{quoteId}/accept", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await finance.PostAsJsonAsync($"{Projects}/{projectId}/status", new { status = "Active" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        // Management reads and acts on every quote, including one nobody owns, and may give any quote to anyone.
        (await management.GetAsync($"{Sales}/quotes/{orphan}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await management.TransferQuoteAsync(orphan, await b.UserIdAsync())).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await b.GetAsync($"{Sales}/quotes/{orphan}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.GetAsync($"{Projects}/{projectId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Roles come from the sign-in alone: the development sign-in does not exist here, and no parameter widens a list.
        (await factory.AnonymousClient().GetAsync("/bff/dev-login?role=Crm.Admin", Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
        (await IdsAsync(b, $"{Sales}/quotes?search={marker}&role=Crm.Admin&mine=false&ownerId={await a.UserIdAsync()}")).ShouldBe([orphan]);

        // What each role is told about its scope.
        foreach (var (role, allQuotes, allProjects) in new[]
                 {
                     (CrmRoles.Sales, false, true), (CrmRoles.Technician, false, false), (CrmRoles.ServiceLead, false, true),
                     (CrmRoles.ReadOnly, false, true), (CrmRoles.Finance, true, true), (CrmRoles.Management, true, true), (CrmRoles.Admin, true, true),
                 })
        {
            var told = (await factory.ClientAs(role, userKey: $"scope-told-{role}").GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("recordScope");
            told.GetProperty("mode").GetString().ShouldBe("Restricted", role);
            told.GetProperty("allQuotes").GetBoolean().ShouldBe(allQuotes, role);
            told.GetProperty("allProjects").GetBoolean().ShouldBe(allProjects, role);
        }

        // The report: the mode, who sees what, and how records are spread over people (dry run before rollout).
        var report = await admin.GetFromJsonAsync<JsonElement>("/api/v1/admin/record-scope", Ct);
        report.GetProperty("mode").GetString().ShouldBe("Restricted");
        var quotes = report.GetProperty("sections").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "quotes");
        Roles(quotes, "rolesSeeingAll").ShouldBe([CrmRoles.Admin, CrmRoles.Finance, CrmRoles.Management]);
        Roles(quotes, "rolesLimited").ShouldBe([CrmRoles.ReadOnly, CrmRoles.Sales, CrmRoles.ServiceLead, CrmRoles.Technician]);
        var aId = await a.UserIdAsync();
        quotes.GetProperty("assignees").EnumerateArray().Single(p => p.GetProperty("userId").GetGuid() == aId).GetProperty("records").GetInt32().ShouldBe(1);
        var projects = report.GetProperty("sections").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "projects");
        Roles(projects, "rolesLimited").ShouldBe([CrmRoles.Technician]);
        projects.GetProperty("withoutAssignee").GetInt32().ShouldBeGreaterThanOrEqualTo(1);
        (await management.GetAsync("/api/v1/admin/record-scope", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static string[] Roles(JsonElement section, string property) =>
        section.GetProperty(property).EnumerateArray().Select(r => r.GetString()!).ToArray();

    private static async Task<string> EtagAsync(HttpClient client, string url) =>
        (await client.GetFromJsonAsync<JsonElement>(url, Ct)).GetProperty("etag").GetString()!;

    private static async Task<List<Guid>> IdsAsync(HttpClient client, string url) =>
        (await client.GetFromJsonAsync<JsonElement>(url, Ct)).EnumerateArray().Select(e => e.GetProperty("id").GetGuid()).ToList();

    private static async Task<Guid> ProjectAsync(HttpClient client, Guid organizationId, string name, Guid? managerId)
    {
        var created = await client.PostAsJsonAsync(Projects, new
        {
            organizationId,
            name,
            type = "Other",
            billingModel = "TimeAndMaterial",
            managerId,
            startDate = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            budgetHours = 10m,
            budgetAmount = 0m,
        }, Ct);
        created.StatusCode.ShouldBe(HttpStatusCode.Created, await created.Content.ReadAsStringAsync(Ct));
        return (await created.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    private static async Task TaskForAsync(HttpClient client, Guid projectId, Guid assigneeId)
    {
        var phase = await (await client.PostAsJsonAsync($"{Projects}/{projectId}/phases", new
        {
            name = "Utrulling", plannedStart = (string?)null, plannedEnd = (string?)null, plannedHours = 4m, fee = 0m, billOnCompletion = false, productId = (Guid?)null,
        }, Ct)).ReadJsonAsync();
        var phaseId = phase.GetProperty("phases").EnumerateArray().Single().GetProperty("id").GetGuid();
        (await client.PostAsJsonAsync($"{Projects}/{projectId}/phases/{phaseId}/tasks", new
        {
            title = "Installere klienter", assigneeId, dueDate = (string?)null, estimatedHours = 4m, notes = (string?)null, status = (string?)null,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static Task<HttpResponseMessage> BookAsync(HttpClient technician, Guid organizationId, Guid projectId) =>
        technician.PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId,
            workDate = Today.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            hours = 2m,
            workType = "Onsite",
            billable = true,
            onsite = true,
            afterHours = false,
            description = "Prosjektarbeid",
            projectId,
        }, Ct);

    private async Task<Guid> MemberRowAsync(Guid projectId, Guid userId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<Crm.Projects.Persistence.ProjectsDbContext>().ProjectMembers
            .IgnoreQueryFilters().AsNoTracking().Where(m => m.ProjectId == projectId && m.UserId == userId).Select(m => m.Id).SingleAsync(Ct);
    }
}
