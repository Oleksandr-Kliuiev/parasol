using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Atera;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>The classes that pause an integration share one switch per system, so they must not run at the same time.</summary>
[CollectionDefinition(AteraCollection.Name, DisableParallelization = true)]
public sealed class AteraCollection
{
    public const string Name = "atera";
}

/// <summary>Launch readiness: the incident pause (runbook 05), integration health (NFR §4.3) and data migration (ТЗ §6.6).</summary>
[Collection(AteraCollection.Name)]
public class LaunchReadinessTests(CrmWebFactory factory)
{
    private const string Integrations = "/api/v1/integrations";
    private const string Organizations = "/api/v1/customers/organizations";

    [Fact]
    public async Task A_paused_integration_skips_its_jobs_and_says_so_in_health()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "pause-admin");

        var paused = await admin.PostAsJsonAsync($"{Integrations}/atera/pause", new { paused = true, reason = "Incident 2026-09-24" });
        paused.StatusCode.ShouldBe(HttpStatusCode.OK);
        HttpResponseMessage resumed;
        try
        {
            var status = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/status");
            var atera = status.EnumerateArray().Single(s => s.GetProperty("system").GetString() == "atera");
            atera.GetProperty("paused").GetBoolean().ShouldBeTrue();
            atera.GetProperty("pauseReason").GetString().ShouldBe("Incident 2026-09-24");
            atera.GetProperty("pausedBy").GetString().ShouldNotBeNullOrEmpty();

            // The job still records that it fell due, but reads nothing.
            await factory.RunJobAsync<AteraCustomerSyncJob>(job => job.RunAsync(CancellationToken.None));
            var runs = await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/runs?system=atera&limit=1");
            var run = runs.GetProperty("items").EnumerateArray().First();
            run.GetProperty("status").GetString().ShouldBe("Skipped");
            run.GetProperty("read").GetInt32().ShouldBe(0);
            run.GetProperty("message").GetString().ShouldBeNull(); // Pause details remain on the operator system card.

            var health = await admin.GetFromJsonAsync<JsonElement>("/health/integrations");
            var healthAtera = health.GetProperty("systems").EnumerateArray().Single(s => s.GetProperty("system").GetString() == "atera");
            healthAtera.GetProperty("paused").GetBoolean().ShouldBeTrue();
            // A paused system is a decision, not a fault: it must not make the health report degraded on its own.
            healthAtera.GetProperty("healthy").GetBoolean().ShouldBeTrue();
        }
        finally
        {
            // Resumed even when an assertion above fails: a pause left behind would fail every Atera test that runs after this one.
            resumed = await admin.PostAsJsonAsync($"{Integrations}/atera/pause", new { paused = false, reason = (string?)null });
        }

        resumed.StatusCode.ShouldBe(HttpStatusCode.OK);
        (await admin.GetFromJsonAsync<JsonElement>($"{Integrations}/status")).EnumerateArray()
            .Single(s => s.GetProperty("system").GetString() == "atera")
            .GetProperty("paused").GetBoolean().ShouldBeFalse();

        // Health is for monitoring only: a role without integrations.manage does not get it.
        var finance = factory.ClientAs(CrmRoles.Finance, userKey: "pause-finance");
        (await finance.GetAsync("/health/integrations")).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await finance.PostAsJsonAsync($"{Integrations}/atera/pause", new { paused = true, reason = "nope" })).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task The_migration_file_is_previewed_then_imported_and_matches_what_is_already_there()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "migration-admin");
        var marker = $"M{Guid.NewGuid():N}"[..8];
        var orgNumber = TestData.OrgNumber();
        var existingId = await admin.CreateOrganizationAsync(new { name = $"{marker} Eksisterende AS", orgNumber, status = "Customer" });

        var csv = string.Join('\n',
            "Navn;Organisasjonsnummer;E-post;Telefon;Domene;Poststed;Fornavn;Etternavn;Kontaktepost;Kontaktrolle",
            $"{marker} Eksisterende AS;{orgNumber};post@eksisterende.no;22334455;eksisterende.no;Oslo;Kari;Nordmann;kari@eksisterende.no;Faktura",
            $"{marker} Ny Kunde AS;{TestData.OrgNumber()};post@nykunde.no;22112233;nykunde.no;Bergen;Ola;Nordmann;ola@nykunde.no;Teknisk",
            $"{marker} Uten nummer AS;ikke et nummer;;;;Trondheim;;;;");

        var preview = await (await admin.PostAsync(
            $"{Organizations}/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        preview.GetProperty("created").GetInt32().ShouldBe(2);
        preview.GetProperty("updated").GetInt32().ShouldBe(1);
        preview.GetProperty("contacts").GetInt32().ShouldBe(2);
        preview.GetProperty("warnings").EnumerateArray().ShouldContain(w => w.GetString()!.Contains("ikke et nummer", StringComparison.Ordinal));

        // The preview wrote nothing.
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}"))
            .GetProperty("items").GetArrayLength().ShouldBe(1);

        var imported = await (await admin.PostAsync(
            $"{Organizations}/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        imported.GetProperty("created").GetInt32().ShouldBe(2);
        imported.GetProperty("updated").GetInt32().ShouldBe(1);

        var items = (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}")).GetProperty("items");
        items.GetArrayLength().ShouldBe(3);

        // The existing customer was matched on its organization number and filled in, not duplicated.
        var existing = await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{existingId}");
        existing.GetProperty("email").GetString().ShouldBe("post@eksisterende.no");
        existing.GetProperty("domains").EnumerateArray().Select(d => d.GetString()).ShouldContain("eksisterende.no");
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{existingId}/contacts"))
            .EnumerateArray().ShouldContain(c => c.GetProperty("email").GetString() == "kari@eksisterende.no");

        // Running the same file again changes nothing.
        var again = await (await admin.PostAsync(
            $"{Organizations}/import", new StringContent(csv, Encoding.UTF8, "text/csv"))).ReadJsonAsync();
        again.GetProperty("created").GetInt32().ShouldBe(0);
        again.GetProperty("updated").GetInt32().ShouldBe(0);
        again.GetProperty("unchanged").GetInt32().ShouldBe(3);

        // Migration is a delete-level right: sales cannot run it.
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "migration-sales");
        (await sales.PostAsync($"{Organizations}/import?dryRun=true", new StringContent(csv, Encoding.UTF8, "text/csv")))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task A_file_without_a_name_column_is_refused_with_a_reason()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "migration-admin2");
        var response = await admin.PostAsync(
            $"{Organizations}/import?dryRun=true",
            new StringContent("orgnr;telefon\n923609016;22334455", Encoding.UTF8, "text/csv"));

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_MIGRATION_INVALID");
        _ = CultureInfo.InvariantCulture;
    }
}
