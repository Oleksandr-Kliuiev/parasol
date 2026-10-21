using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.Activities.Features;
using Crm.Activities.Persistence;
using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;

namespace Crm.IntegrationTests;

/// <summary>Exact Activity links use the existing customer-scoped list, without reading through older pages.</summary>
public sealed class ActivityFocusApiTests(CrmWebFactory factory)
{
    private const string Endpoint = "/api/v1/activities";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_older_generic_source_Task_beyond_the_default_page_is_selected_once_with_its_editable_DTO()
    {
        var organization = await Organization(factory);
        using var technician = factory.ClientAs(CrmRoles.Technician, "activity-focus-" + Guid.NewGuid().ToString("N"));
        var employee = (await technician.GetFromJsonAsync<JsonElement>("/bff/user", Ct)).GetProperty("id").GetGuid();
        var source = Source();
        var due = DateTimeOffset.Parse("2090-01-01T10:30:45.123Z");
        await using var host = Host(factory, employee);
        var created = (await Create(host, new(source, organization, employee, due.AddDays(100), ActivityPriority.High))).Value;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            for (var i = 0; i < KeysetCursor.DefaultLimit + 10; i++)
                db.Activities.Add(Activity.Create(new(ActivityType.Task, organization, null, null, null,
                    "Review technical observation", null, due.AddDays(i), ActivityPriority.Normal, employee), due).Value);
            await db.SaveChangesAsync(Ct);
        }

        var before = await State(created.ActivityId);
        var ordinary = await Page(technician, $"?organizationId={organization}");
        ordinary.GetProperty("totalCount").GetInt32().ShouldBe(KeysetCursor.DefaultLimit + 11);
        ordinary.GetProperty("items").GetArrayLength().ShouldBe(KeysetCursor.DefaultLimit);
        ordinary.GetProperty("items").EnumerateArray().ShouldNotContain(row => row.GetProperty("id").GetGuid() == created.ActivityId);
        var cursor = ordinary.GetProperty("nextCursor").GetString(); cursor.ShouldNotBeNullOrEmpty();

        using var finance = factory.ClientAs(CrmRoles.Finance, "activity-focus-finance-" + Guid.NewGuid().ToString("N"));
        var selected = await Page(finance, Focus(organization, created.ActivityId));
        selected.GetProperty("totalCount").GetInt32().ShouldBe(1);
        selected.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
        var dto = selected.GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        dto.GetProperty("id").GetGuid().ShouldBe(created.ActivityId);
        dto.GetProperty("organizationId").GetGuid().ShouldBe(organization);
        dto.GetProperty("subject").GetString().ShouldBe("Review technical observation");
        dto.GetProperty("body").ValueKind.ShouldBe(JsonValueKind.Null);
        dto.GetProperty("hasTechnicalSource").GetBoolean().ShouldBeTrue();
        dto.GetProperty("dueAt").GetDateTimeOffset().ShouldBe(due.AddDays(100));
        dto.GetProperty("assignee").GetProperty("id").GetGuid().ShouldBe(employee);
        dto.GetProperty("etag").GetString().ShouldNotBeNullOrEmpty();
        foreach (var value in new[] { source.WorkspaceId, source.ClientId, source.ObservationId })
            dto.GetRawText().ShouldNotContain(value);

        // Ordinary continuation still has its prior shape and returns the same persisted DTO/ETag.
        var next = await Page(technician, $"?organizationId={organization}&cursor={Uri.EscapeDataString(cursor!)}");
        next.GetProperty("totalCount").GetInt32().ShouldBe(KeysetCursor.DefaultLimit + 11);
        next.GetProperty("items").GetArrayLength().ShouldBe(11);
        next.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
        next.GetProperty("items").EnumerateArray().Single(row => row.GetProperty("id").GetGuid() == created.ActivityId)
            .GetRawText().ShouldBe(dto.GetRawText());
        var after = await State(created.ActivityId);
        after.RowVersion.ShouldBe(before.RowVersion); after.AuditIds.ShouldBe(before.AuditIds); after.OutboxIds.ShouldBe(before.OutboxIds);
    }

    [Theory]
    [InlineData("wrong-customer")]
    [InlineData("missing-activity")]
    [InlineData("deleted-activity")]
    [InlineData("erased-activity")]
    [InlineData("missing-customer")]
    [InlineData("deleted-customer")]
    [InlineData("merged-customer")]
    [InlineData("moved-activity")]
    public async Task Unavailable_or_out_of_customer_selection_is_the_same_empty_page_without_fallback(string reason)
    {
        var organization = await Organization(factory); var other = await Organization(factory);
        var activity = await Seed(organization); var selectedOrganization = organization; var selectedActivity = activity;
        using var client = factory.ClientAs(CrmRoles.Admin);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            var customers = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            switch (reason)
            {
                case "wrong-customer": selectedOrganization = other; break;
                case "missing-activity": selectedActivity = Guid.NewGuid(); break;
                case "deleted-activity": (await db.Activities.SingleAsync(a => a.Id == activity, Ct)).MarkDeleted(); break;
                case "erased-activity": (await db.Activities.SingleAsync(a => a.Id == activity, Ct)).Erase("SYNTHETIC-FOCUS-ERASURE"); break;
                case "missing-customer": selectedOrganization = Guid.NewGuid(); break;
                case "deleted-customer": (await customers.Organizations.SingleAsync(o => o.Id == organization, Ct)).MarkDeleted(); break;
                case "merged-customer":
                    (await client.PostAsJsonAsync($"/api/v1/customers/organizations/{other}/merge", new { sourceOrganizationId = organization }, Ct))
                        .StatusCode.ShouldBe(HttpStatusCode.OK);
                    break;
                case "moved-activity":
                    await db.Activities.Where(a => a.Id == activity).ExecuteUpdateAsync(u => u.SetProperty(a => a.OrganizationId, other), Ct);
                    break;
            }
            await db.SaveChangesAsync(Ct); await customers.SaveChangesAsync(Ct);
        }

        // A different live Activity exists: refusal must not silently return the ordinary timeline.
        await Seed(other);
        var page = await Page(client, Focus(selectedOrganization, selectedActivity));
        Empty(page);
        page.GetRawText().ShouldNotContain(activity.ToString());
        page.GetRawText().ShouldNotContain(organization.ToString());
        page.GetRawText().ShouldNotContain(other.ToString());
    }

    [Theory]
    [InlineData("type=Note")]
    [InlineData("opportunityId=11111111-1111-1111-1111-111111111111")]
    [InlineData("contractId=22222222-2222-2222-2222-222222222222")]
    [InlineData("mine=true")]
    public async Task Exact_selection_keeps_other_filters_as_intersections(string filter)
    {
        var organization = await Organization(factory); var activity = await Seed(organization);
        using var client = factory.ClientAs(CrmRoles.ReadOnly, "activity-focus-reader-" + Guid.NewGuid().ToString("N"));
        Empty(await Page(client, Focus(organization, activity) + "&" + filter));
        (await Page(client, Focus(organization, activity))).GetProperty("items").GetArrayLength().ShouldBe(1);
    }

    [Fact]
    public async Task A_completed_selected_Task_is_visible_unless_open_only_was_explicitly_requested()
    {
        var organization = await Organization(factory); var activity = await Seed(organization);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
            (await db.Activities.SingleAsync(a => a.Id == activity, Ct)).Complete(null, DateTimeOffset.UtcNow);
            await db.SaveChangesAsync(Ct);
        }
        using var client = factory.ClientAs(CrmRoles.ReadOnly);
        var dto = (await Page(client, Focus(organization, activity))).GetProperty("items").EnumerateArray().ShouldHaveSingleItem();
        dto.GetProperty("status").GetString().ShouldBe("Done");
        Empty(await Page(client, Focus(organization, activity) + "&open=true"));
    }

    [Theory]
    [InlineData("missing-scope")]
    [InlineData("empty-scope")]
    [InlineData("empty-id")]
    [InlineData("blank-id")]
    [InlineData("malformed-id")]
    [InlineData("malformed-scope")]
    [InlineData("cursor")]
    [InlineData("blank-cursor")]
    [InlineData("duplicate-id")]
    public async Task Invalid_selection_never_broadens_into_an_ordinary_list(string reason)
    {
        var organization = await Organization(factory); var activity = await Seed(organization);
        var query = reason switch
        {
            "missing-scope" => $"?activityId={activity}",
            "empty-scope" => Focus(Guid.Empty, activity),
            "empty-id" => Focus(organization, Guid.Empty),
            "blank-id" => $"?organizationId={organization}&activityId=",
            "malformed-id" => $"?organizationId={organization}&activityId=invalid",
            "malformed-scope" => $"?organizationId=invalid&activityId={activity}",
            "cursor" => Focus(organization, activity) + "&cursor=old-cursor",
            "blank-cursor" => Focus(organization, activity) + "&cursor=",
            "duplicate-id" => Focus(organization, activity) + $"&activityId={Guid.NewGuid()}",
            _ => throw new ArgumentException("Unknown test case.", nameof(reason)),
        };
        using var client = factory.ClientAs(CrmRoles.ReadOnly);
        using var response = await client.GetAsync(Endpoint + query, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync(Ct)).ShouldNotContain("Review technical observation");
    }

    [Fact]
    public async Task Selection_keeps_read_and_write_permissions_separate()
    {
        var organization = await Organization(factory); var activity = await Seed(organization);
        using var reader = factory.ClientAs(CrmRoles.ReadOnly);
        (await Page(reader, Focus(organization, activity))).GetProperty("items").GetArrayLength().ShouldBe(1);
        (await reader.PostAsync($"{Endpoint}/{activity}/complete", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var unknownRole = factory.ClientAs("Crm.Unknown", "activity-focus-no-read-" + Guid.NewGuid().ToString("N"));
        (await unknownRole.GetAsync(Endpoint + Focus(organization, activity), Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        using var anonymous = factory.AnonymousClient();
        (await anonymous.GetAsync(Endpoint + Focus(organization, activity), Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Service_calls_also_reject_unscoped_or_continued_exact_reads()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<ActivityService>();
        var id = Guid.NewGuid();
        foreach (var query in new[]
        {
            new ActivityQuery(null, null, null, null, false, false, ActivityId: id),
            new ActivityQuery(Guid.Empty, null, null, null, false, false, ActivityId: id),
            new ActivityQuery(Guid.NewGuid(), null, null, null, false, false, ActivityId: Guid.Empty),
        })
            (await service.ListAsync(query, Ct)).Error!.Code.ShouldBe("ACT_SELECTION_SCOPE_REQUIRED");
        (await service.ListAsync(new(Guid.NewGuid(), null, null, null, false, false, Cursor: "", ActivityId: id), Ct))
            .Error!.Code.ShouldBe("ACT_SELECTION_CURSOR_INVALID");
    }

    private async Task<Guid> Seed(Guid organization)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var activity = Activity.Create(new(ActivityType.Task, organization, null, null, null, "Review technical observation",
            null, DateTimeOffset.Parse("2090-01-01T10:30:45.123Z"), ActivityPriority.Normal, null), DateTimeOffset.UtcNow).Value;
        db.Activities.Add(activity); await db.SaveChangesAsync(Ct); return activity.Id;
    }
    private static string Focus(Guid organization, Guid activity) => $"?organizationId={organization}&activityId={activity}";
    private static async Task<JsonElement> Page(HttpClient client, string query)
    {
        using var response = await client.GetAsync(Endpoint + query, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }
    private static void Empty(JsonElement page)
    {
        page.GetProperty("items").GetArrayLength().ShouldBe(0);
        page.GetProperty("totalCount").GetInt32().ShouldBe(0);
        page.GetProperty("nextCursor").ValueKind.ShouldBe(JsonValueKind.Null);
    }
    private sealed record ReadEvidence(string RowVersion, long[] AuditIds, Guid[] OutboxIds);
    private async Task<ReadEvidence> State(Guid activityId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ActivitiesDbContext>();
        var activity = await db.Activities.SingleAsync(a => a.Id == activityId, Ct);
        var audits = await db.AuditEntries.AsNoTracking().Where(a => a.EntityType == nameof(Activity) && a.EntityId == activityId)
            .OrderBy(a => a.Id).Select(a => a.Id).ToArrayAsync(Ct);
        var id = activityId.ToString();
        var events = await db.OutboxMessages.AsNoTracking().Where(e => e.Type.Contains(nameof(ActivityLogged)) && e.Payload.Contains(id))
            .OrderBy(e => e.Id).Select(e => e.Id).ToArrayAsync(Ct);
        return new(db.GetETag(activity), audits, events);
    }
}
