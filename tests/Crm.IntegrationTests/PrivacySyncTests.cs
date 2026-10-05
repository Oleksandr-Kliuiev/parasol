using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Persistence;
using Crm.Integrations.Atera;
using Crm.Integrations.Core.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-11-AC05: once a person is erased, the next synchronization, an import of their external record or an old system's file
/// does not bring them back; only lifting their suppression — a new lawful basis, recorded — lets the external systems do so.
/// Atera's contact listing is one global endpoint, so the class runs with the other Atera classes.
/// </summary>
[Collection(AteraCollection.Name)]
public sealed class PrivacySyncTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC05_the_next_synchronization_or_import_does_not_restore_an_erased_person_without_a_new_lawful_basis()
    {
        var person = await PrivacyTestData.PersonAsync(factory);
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-sync-{person.Marker.ToLowerInvariant()}");
        var (caseId, etag) = await PrivacyTests.OpenAsync(admin, "Erasure", "Contact", person.ContactId);
        etag = await PrivacyTests.VerifyAsync(admin, caseId, etag);
        var plan = await PrivacyTests.PreviewAsync(admin, caseId, etag);
        var number = (await admin.GetFromJsonAsync<JsonElement>($"/api/v1/privacy/cases/{caseId}", Ct)).GetProperty("number").GetString()!;
        (await PrivacyTests.ExecuteRawAsync(admin, caseId, plan.Etag, plan.Digest, number)).StatusCode.ShouldBe(HttpStatusCode.OK);

        // Atera still has the person — and a stranger at the same customer, who is synchronized as usual.
        var strangerId = Random.Shared.Next(100_000_000, 999_999_999);
        var strangerEmail = $"fremmed.{person.Marker.ToLowerInvariant()}@example.no";
        ContactsInAtera(person, strangerId, strangerEmail);
        await factory.RunJobAsync<AteraContactSyncJob>(j => j.RunAsync(CancellationToken.None));

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
            var erased = await db.ExternalRecords.AsNoTracking().SingleAsync(r => r.System == "atera" && r.ExternalType == "Contact" && r.ExternalId == person.AteraContactId, Ct);
            erased.DisplayName.ShouldBe("—");
            erased.Email.ShouldBeNull();
            erased.Payload.ShouldBe("{}");
            (await db.ExternalLinks.AnyAsync(l => l.System == "atera" && l.ExternalId == person.AteraContactId, Ct)).ShouldBeFalse("no link comes back");
            var stranger = await db.ExternalRecords.AsNoTracking()
                .SingleAsync(r => r.System == "atera" && r.ExternalType == "Contact" && r.ExternalId == strangerId.ToString(System.Globalization.CultureInfo.InvariantCulture), Ct);
            stranger.Email.ShouldBe(strangerEmail);
            (await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().Contacts.IgnoreQueryFilters().CountAsync(c => c.Email == person.Email, Ct))
                .ShouldBe(0, "no CRM contact carries the address again");
        }

        var import = await admin.PostAsync($"/api/v1/integrations/records/atera/Contact/{person.AteraContactId}/import", null, Ct);
        import.StatusCode.ShouldBe(HttpStatusCode.Conflict, await import.Content.ReadAsStringAsync(Ct));
        (await import.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("PRV_SUPPRESSED");

        // An old system's file with the person: previewed and imported, the person is left out — and says why, without who.
        var csv = $"name;contactfirstname;contactlastname;contactemail\n{person.Marker} Personvern AS;{person.FirstName};{person.LastName};{person.Email}\n";
        foreach (var dryRun in new[] { true, false })
        {
            var migrated = await admin.PostAsync($"/api/v1/customers/organizations/import?dryRun={dryRun.ToString().ToLowerInvariant()}",
                new StringContent(csv, Encoding.UTF8, "text/csv"), Ct);
            migrated.StatusCode.ShouldBe(HttpStatusCode.OK, await migrated.Content.ReadAsStringAsync(Ct));
            var result = await migrated.ReadJsonAsync();
            result.GetProperty("contacts").GetInt32().ShouldBe(0);
            var warnings = result.GetProperty("warnings").EnumerateArray().Select(w => w.GetString()!).ToList();
            warnings.ShouldContain(w => w.Contains("CONTACT_SUPPRESSED", StringComparison.Ordinal));
            warnings.ShouldAllBe(w => !w.Contains(person.Email, StringComparison.OrdinalIgnoreCase) && !w.Contains(person.FirstName, StringComparison.Ordinal));
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().Contacts.IgnoreQueryFilters().CountAsync(c => c.Email == person.Email, Ct)).ShouldBe(0);
        }

        // A new lawful basis — the person became a contact again with consent: the suppressions are lifted, with a reason.
        var suppressions = (await admin.GetFromJsonAsync<JsonElement>("/api/v1/privacy/suppressions?limit=200", Ct)).GetProperty("items").EnumerateArray()
            .Where(s => s.GetProperty("caseId").GetGuid() == caseId).ToList();
        suppressions.Select(s => s.GetProperty("kind").GetString()).ShouldBe(["Email", "ExternalReference"], ignoreOrder: true);
        foreach (var suppression in suppressions)
        {
            (await admin.PostWithETagAsync($"/api/v1/privacy/suppressions/{suppression.GetProperty("id").GetGuid()}/lift",
                new { reason = "Signed a new agreement and asked to be contacted (test)." }, suppression.GetProperty("etag").GetString()!)).StatusCode.ShouldBe(HttpStatusCode.OK);
        }

        ContactsInAtera(person, strangerId, strangerEmail);
        await factory.RunJobAsync<AteraContactSyncJob>(j => j.RunAsync(CancellationToken.None));
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var back = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords.AsNoTracking()
                .SingleAsync(r => r.System == "atera" && r.ExternalType == "Contact" && r.ExternalId == person.AteraContactId, Ct);
            back.Email.ShouldBe(person.Email);
            back.DisplayName.ShouldBe($"{person.FirstName} {person.LastName}");
        }
    }

    private void ContactsInAtera(PrivacyPerson person, int strangerId, string strangerEmail) =>
        factory.Atera.Given(Request.Create().WithPath("/api/v3/contacts").UsingGet().WithParam("page", "1"))
            .RespondWith(Response.Create().WithStatusCode(200).WithHeader("Content-Type", "application/json").WithBodyAsJson(new
            {
                items = new object[]
                {
                    new { EndUserID = long.Parse(person.AteraContactId, System.Globalization.CultureInfo.InvariantCulture), CustomerID = 1, Firstname = person.FirstName, Lastname = person.LastName, Email = person.Email },
                    new { EndUserID = (long)strangerId, CustomerID = 1, Firstname = "Fremmed", Lastname = person.Marker, Email = strangerEmail },
                },
                totalItemCount = 2, page = 1, itemsInPage = 2, totalPages = 1,
            }));
}
