using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Actions;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M39.3: a person's own CRM time entry also recorded in Atera, as their technician and marked with the entry, so that a repeat finds
/// the row already there and the work-hours import never counts the hours a second time.
/// </summary>
[Collection(AteraCollection.Name)]
public class AteraTimeRecordingTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] Kinds = [.. AteraTicketKinds.All, AteraTimeRecordAction.KindName];

    private static async Task<Guid> EntryAsync(AteraTicketHost host, TestTicket ticket, string description = "Feilsøking av skriver")
    {
        var response = await host.Client().PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId = ticket.OrganizationId, workDate = new DateOnly(2026, 10, 20), hours = 1.5m, billable = true, onsite = false, afterHours = false,
            description, externalTicketId = ticket.TicketId,
        }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.Created, await response.Content.ReadAsStringAsync(Ct));
        return (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    private static Task<JsonElement> PreviewAsync(AteraTicketHost host, Guid entryId) => host.Client().PostAsJsonAsync("/api/v1/actions/preview", new
    {
        system = "atera", kind = AteraTimeRecordAction.KindName, targetType = AteraTimeRecordAction.Target, targetId = entryId.ToString("D"), parameters = new { },
    }, Ct).ContinueWith(t => t.Result.ReadJsonAsync(), Ct).Unwrap();

    private static async Task<Guid> AskAsync(AteraTicketHost host, Guid entryId)
    {
        var preview = await PreviewAsync(host, entryId);
        preview.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, preview.ToString());
        var command = await host.Client().PostAsJsonAsync("/api/v1/actions", new
        {
            system = "atera", kind = AteraTimeRecordAction.KindName, targetType = AteraTimeRecordAction.Target, targetId = entryId.ToString("D"), parameters = new { },
            previewToken = preview.GetProperty("previewToken").GetString(), commandKey = Guid.NewGuid(),
        }, Ct);
        command.StatusCode.ShouldBe(HttpStatusCode.Accepted, await command.Content.ReadAsStringAsync(Ct));
        return (await command.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    [Fact]
    public async Task Own_time_is_recorded_once_as_the_persons_technician_and_never_imported_back()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: Kinds);
        var ticket = await host.TicketAsync();
        await host.MapTechnicianAsync();
        var entryId = await EntryAsync(host, ticket);
        var hoursPath = $"/api/v3/tickets/{ticket.TicketId}/workhoursrecords";
        host.On("GET", hoursPath).RespondWith(JsonReply(Array.Empty<object>()));
        host.On("POST", $"/api/v3/tickets/{ticket.TicketId}/workhours").RespondWith(JsonReply(new { ActionID = "wh-77" }));

        var preview = await PreviewAsync(host, entryId);
        preview.GetProperty("target").GetProperty("name").GetString().ShouldBe($"1.5 h · #{ticket.TicketId} Printer is down");
        var record = preview.GetProperty("effects")[0];
        record.GetProperty("code").GetString().ShouldBe("VND_EFFECT_TIME_RECORD");
        // No times on a manual entry: 08:00 on its work date in Oslo, for its duration, and the confirmation says so.
        (record.GetProperty("values").GetProperty("from").GetString(), record.GetProperty("values").GetProperty("to").GetString()).ShouldBe(("08:00", "09:30"));
        preview.GetProperty("effects")[1].GetProperty("code").GetString().ShouldBe("VND_EFFECT_TIME_DEFAULT_START");

        var action = await host.RunAsync(await AskAsync(host, entryId));
        action.Status.ShouldBe(VendorActionStatus.Succeeded, action.Outcome);
        action.Reference.ShouldBe("wh-77");
        var posted = host.Posted($"/api/v3/tickets/{ticket.TicketId}/workhours");
        posted.GetProperty("StartWorkHour").GetDateTimeOffset().ShouldBe(new DateTimeOffset(2026, 10, 20, 6, 0, 0, TimeSpan.Zero));
        posted.GetProperty("EndWorkHour").GetDateTimeOffset().ShouldBe(new DateTimeOffset(2026, 10, 20, 7, 30, 0, TimeSpan.Zero));
        posted.GetProperty("TechnicianContactID").GetInt64().ShouldBe(host.Technician);
        posted.GetProperty("Billiable").GetBoolean().ShouldBeTrue();
        posted.GetProperty("Comments").GetString().ShouldBe($"Feilsøking av skriver\n\n{AteraTimeMarker.Of(entryId)}");

        // Atera lists the row back, with the entry's marker: a second request finds it and sends nothing.
        host.On("GET", hoursPath).RespondWith(JsonReply(new object[]
        {
            new { WorkHoursID = "wh-77", TicketID = ticket.TicketId, TimeSpentInMinutes = 90, StartWorkHour = "2026-10-20T06:00:00Z", Comments = posted.GetProperty("Comments").GetString() },
            new { WorkHoursID = "wh-78", TicketID = ticket.TicketId, TimeSpentInMinutes = 30, StartWorkHour = "2026-10-20T10:00:00Z", Description = "Recorded in Atera itself" },
        }));
        var repeat = await host.RunAsync(await AskAsync(host, entryId));
        repeat.Status.ShouldBe(VendorActionStatus.Skipped);
        repeat.Reference.ShouldBe("wh-77");
        host.Count("POST", $"/api/v3/tickets/{ticket.TicketId}/workhours").ShouldBe(1);

        // The work-hours import takes the row recorded in Atera itself and leaves the CRM's own row alone.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<AteraWorkHoursSyncJob>().RunAsync(Ct);
        }

        await using var read = host.Services.CreateAsyncScope();
        var entries = await read.ServiceProvider.GetRequiredService<TimeTrackingDbContext>().TimeEntries.AsNoTracking()
            .Where(e => e.ExternalTicketId == ticket.TicketId).Select(e => new { e.Id, e.ExternalId, e.Hours }).ToListAsync(Ct);
        entries.ShouldContain(e => e.Id == entryId && e.ExternalId == null);
        entries.ShouldContain(e => e.ExternalId == "wh-78");
        entries.ShouldNotContain(e => e.ExternalId == "wh-77");
        entries.Sum(e => e.Hours).ShouldBe(2.0m, "1.5 h from the CRM and 0.5 h recorded in Atera itself, never 1.5 h twice");

        // An entry the import brought from Atera is already there: it cannot be recorded again.
        var imported = entries.Single(e => e.ExternalId == "wh-78").Id;
        (await PreviewAsync(host, imported)).GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TIME_FROM_ATERA");
    }

    [Fact]
    public async Task Only_the_person_whose_time_it_is_records_it_and_only_on_a_ticket_of_its_customer()
    {
        await using var host = AteraTicketHost.Start(factory, kinds: Kinds);
        var ticket = await host.TicketAsync();
        await host.MapTechnicianAsync();
        var mine = await EntryAsync(host, ticket);

        await using var other = AteraTicketHost.Start(factory, kinds: Kinds);
        (await (await other.Client().PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTimeRecordAction.KindName, targetType = AteraTimeRecordAction.Target, targetId = mine.ToString("D"), parameters = new { },
        }, Ct)).ReadJsonAsync()).GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TIME_NOT_OWN");

        var noTicket = await host.Client().PostAsJsonAsync("/api/v1/time/entries", new
        {
            organizationId = ticket.OrganizationId, workDate = new DateOnly(2026, 10, 20), hours = 1m, billable = true, onsite = false, afterHours = false,
            description = "Uten sak",
        }, Ct);
        var withoutTicket = (await noTicket.ReadJsonAsync()).GetProperty("id").GetGuid();
        (await PreviewAsync(host, withoutTicket)).GetProperty("block").GetProperty("code").GetString().ShouldBe("VND_TIME_NO_TICKET");
        (await host.Client().PostAsJsonAsync("/api/v1/actions/preview", new
        {
            system = "atera", kind = AteraTimeRecordAction.KindName, targetType = AteraTimeRecordAction.Target, targetId = Guid.NewGuid().ToString("D"), parameters = new { },
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public void The_marker_reads_back_only_from_a_whole_entry_id()
    {
        var id = Guid.NewGuid();
        AteraTimeMarker.Read(AteraTimeMarker.Embed("Feilsøking", id)).ShouldBe(id);
        AteraTimeMarker.Read(AteraTimeMarker.Embed(null, id)).ShouldBe(id);
        AteraTimeMarker.Read("[CRM-TE:not-a-guid]").ShouldBeNull();
        AteraTimeMarker.Read("Feilsøking").ShouldBeNull();
        AteraTimeMarker.Read(null).ShouldBeNull();
        AteraTimeRecordAction.Window(new Crm.TimeTracking.Contracts.TimeEntryForSending(
            id, Crm.TimeTracking.Contracts.TimeSource.Crm, Guid.NewGuid(), null, 1, null, new DateOnly(2026, 1, 15), null, null, 0.25m, true, false, null))
            .ShouldBe((new DateTimeOffset(2026, 1, 15, 7, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 1, 15, 7, 15, 0, TimeSpan.Zero)), "winter: Oslo is UTC+1");
    }
}
