using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;
using Crm.Customers.Domain;
using Crm.Customers.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-20: the migration import — a manifest per call, quality checks with machine-readable reasons, gap-filling only, chunked
/// commits that resume, and a repeat that changes nothing. Synthetic data only; every test uses markers of its own because the
/// database is shared with the rest of the suite.
/// </summary>
public sealed class MigrationImportTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Raw bytes as the upload sends them: a CSV import takes only text/csv or text/plain (F-G2-05), whatever the encoding.</summary>
    private static ByteArrayContent Csv(byte[] bytes)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new("text/csv");
        return content;
    }

    internal static async Task<HttpResponseMessage> PostAsync(HttpClient client, string csv, bool dryRun, string? expectedSha256 = null)
    {
        var url = $"{Organizations}/import?dryRun={dryRun.ToString().ToLowerInvariant()}" + (expectedSha256 is null ? string.Empty : $"&expectedSha256={expectedSha256}");
        return await client.PostAsync(url, new StringContent(csv, new UTF8Encoding(false), "text/csv"), Ct);
    }

    internal static async Task<JsonElement> ImportAsync(HttpClient client, string csv, bool dryRun, string? expectedSha256 = null)
    {
        var response = await PostAsync(client, csv, dryRun, expectedSha256);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    internal static int Count(JsonElement result, string property) => result.GetProperty(property).GetInt32();

    internal static (int Created, int Updated, int Unchanged, int Conflicts, int Rejected, int Contacts, int Total) Counts(JsonElement r) =>
        (Count(r, "created"), Count(r, "updated"), Count(r, "unchanged"), Count(r, "conflicts"), Count(r, "rejected"), Count(r, "contacts"), Count(r, "rowsTotal"));

    internal static async Task<List<JsonElement>> AllRowsAsync(HttpClient admin, Guid runId, int pageSize = 200)
    {
        var rows = new List<JsonElement>();
        string? cursor = null;
        do
        {
            var url = $"{Organizations}/import/runs/{runId}/rows?limit={pageSize}" + (cursor is null ? string.Empty : $"&cursor={Uri.EscapeDataString(cursor)}");
            var page = await admin.GetFromJsonAsync<JsonElement>(url, Ct);
            rows.AddRange(page.GetProperty("items").EnumerateArray());
            cursor = page.GetProperty("nextCursor").ValueKind == JsonValueKind.Null ? null : page.GetProperty("nextCursor").GetString();
        }
        while (cursor is not null);

        return rows;
    }

    private async Task<(HttpClient Admin, Guid UserId, string Email)> AdminAsync(string key)
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: key);
        return (admin, await admin.UserIdAsync(), $"{key}@test.local");
    }

    private async Task<int> OrganizationCountAsync(HttpClient admin, string search) =>
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={Uri.EscapeDataString(search)}&limit=200", Ct)).GetProperty("items").GetArrayLength();

    [Fact]
    public async Task AC01_AC02_AC03_preview_and_import_count_alike_every_row_has_one_outcome_and_a_repeat_changes_nothing()
    {
        var (admin, adminId, adminEmail) = await AdminAsync("dev20-owner");
        var marker = $"M{Guid.NewGuid():N}"[..9];
        string number1 = TestData.OrgNumber(), number2 = TestData.OrgNumber(), number3 = TestData.OrgNumber(), number4 = TestData.OrgNumber(), number5 = TestData.OrgNumber();
        var toFill = await admin.CreateOrganizationAsync(new { name = $"{marker} Delta AS", orgNumber = number2, status = "Customer" });
        var same = await admin.CreateOrganizationAsync(new { name = $"{marker} Epsilon AS", orgNumber = number3, status = "Customer", email = $"post@epsilon-{marker}.no".ToLowerInvariant() });
        var differs = await admin.CreateOrganizationAsync(new { name = $"{marker} Zeta AS", orgNumber = number4, status = "Customer", email = $"old@zeta-{marker}.no".ToLowerInvariant() });
        var lower = marker.ToLowerInvariant();

        var csv = string.Join('\n',
            "name;orgnr;status;email;phone;domain;owner;contactfirstname;contactlastname;contactemail;vatrate;currency",
            $"{marker} Alfa AS;{number1};customer;post@alfa-{lower}.no;;alfa-{lower}.no;{adminEmail};Ola;Nord;ola@alfa-{lower}.no;25;nok",
            $"{marker} Beta AS;;prospect;;;;;;;;;",
            $"{marker} Alfa Duplikat AS;{number1};customer;;;;;;;;;",
            $"{marker} Beta;;;;;;;;;;;",
            $"{marker} Gamma AS;123456789;;;;;;;;;;",
            $"{marker} Hverdag AS;;bestemor;;;;;;;;;",
            $"{marker} Post AS;;;ikke-en-adresse;;;;;;;;",
            $"{marker} Eierløs AS;;;;;;nobody-{lower}@test.local;;;;;",
            ";;;;;;;;;;;",
            $"{marker} Delta AS;{number2};;post@delta-{lower}.no;22334455;;;;;;;",
            $"{marker} Epsilon AS;{number3};customer;post@epsilon-{lower}.no;;;;;;;;",
            $"{marker} Zeta AS;{number4};;post@zeta-{lower}.no;;;;;;;;");

        // The preview writes no organization — only its own manifest.
        var preview = await ImportAsync(admin, csv, dryRun: true);
        Counts(preview).ShouldBe((Created: 2, Updated: 1, Unchanged: 1, Conflicts: 1, Rejected: 7, Contacts: 1, Total: 12));
        preview.GetProperty("mode").GetString().ShouldBe("DryRun");
        preview.GetProperty("failed").GetInt32().ShouldBe(7, "the older name of the rejected count");
        (await OrganizationCountAsync(admin, marker)).ShouldBe(3, "only the three that existed before");
        var sha = preview.GetProperty("sourceSha256").GetString()!;
        sha.Length.ShouldBe(64);
        preview.GetProperty("mappingVersion").GetString().ShouldBe(ImportRun.CurrentMappingVersion);
        preview.GetProperty("owners").GetProperty("resolved").GetInt32().ShouldBe(1);
        preview.GetProperty("owners").GetProperty("unknown").GetInt32().ShouldBe(1);
        preview.GetProperty("validatedNotImported").GetProperty("vatrate").GetInt32().ShouldBe(1);
        preview.GetProperty("reasonCounts").GetProperty("DUPLICATE_IN_FILE").GetInt32().ShouldBe(2);
        foreach (var code in new[] { "INVALID_ORGNR", "UNKNOWN_STATUS", "INVALID_EMAIL", "OWNER_UNKNOWN", "MISSING_NAME" })
        {
            preview.GetProperty("reasonCounts").GetProperty(code).GetInt32().ShouldBe(1, code);
        }

        // The real import is bound to the file that was previewed.
        var wrong = await PostAsync(admin, csv, dryRun: false, expectedSha256: new string('0', 64));
        wrong.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await wrong.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("IMPORT_SOURCE_CHANGED");
        (await OrganizationCountAsync(admin, marker)).ShouldBe(3);

        var real = await ImportAsync(admin, csv, dryRun: false, expectedSha256: sha);
        Counts(real).ShouldBe(Counts(preview), "the preview counted exactly what the import then did");
        real.GetProperty("status").GetString().ShouldBe("Completed");
        real.GetProperty("repeatKey").GetString().ShouldBe(preview.GetProperty("repeatKey").GetString());
        real.GetProperty("runId").GetGuid().ShouldNotBe(preview.GetProperty("runId").GetGuid());
        real.GetProperty("lastCommittedLine").GetInt32().ShouldBe(13);
        (await OrganizationCountAsync(admin, marker)).ShouldBe(5);

        // What was created carries the owner; the filled one got only its gaps; the one that differs kept its address.
        var alfa = (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}%20Alfa&limit=10", Ct)).GetProperty("items").EnumerateArray().Single();
        var alfaCard = await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{alfa.GetProperty("id").GetGuid()}", Ct);
        alfaCard.GetProperty("accountManager").GetProperty("id").GetGuid().ShouldBe(adminId);
        alfaCard.GetProperty("domains").EnumerateArray().Select(d => d.GetString()).ShouldBe([$"alfa-{lower}.no"]);
        var filled = await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{toFill}", Ct);
        filled.GetProperty("phone").GetString().ShouldBe("22334455");
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{differs}", Ct)).GetProperty("email").GetString().ShouldBe($"old@zeta-{lower}.no");

        // Every source row has exactly one outcome, with a code and field names but no name, address or value.
        var runId = real.GetProperty("runId").GetGuid();
        var run = await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/import/runs/{runId}", Ct);
        Count(run, "rowsTotal").ShouldBe(Count(run, "created") + Count(run, "updated") + Count(run, "unchanged") + Count(run, "conflicts") + Count(run, "rejected"));
        var rows = await AllRowsAsync(admin, runId, pageSize: 5);
        rows.Select(r => r.GetProperty("line").GetInt32()).ShouldBe(Enumerable.Range(2, 12), "paged by line, none twice, none missing");
        var stored = JsonSerializer.Serialize(rows);
        foreach (var secret in new[] { marker, lower, "Alfa", "ola@", "Nord", adminEmail, number1 })
        {
            stored.ShouldNotContain(secret, Case.Insensitive, "outcomes hold line numbers, codes, hashes and ids only");
        }

        rows.Single(r => r.GetProperty("line").GetInt32() == 11).GetProperty("action").GetString().ShouldBe("Updated");
        rows.Single(r => r.GetProperty("line").GetInt32() == 11).GetProperty("fieldsChanged").EnumerateArray().Select(f => f.GetString()).ShouldBe(["phone", "email"], ignoreOrder: true);
        rows.Single(r => r.GetProperty("line").GetInt32() == 12).GetProperty("action").GetString().ShouldBe("Unchanged");
        var conflict = rows.Single(r => r.GetProperty("line").GetInt32() == 13);
        conflict.GetProperty("action").GetString().ShouldBe("Conflict");
        conflict.GetProperty("reasonCode").GetString().ShouldBe("FIELD_CONFLICT");
        conflict.GetProperty("conflictFields").EnumerateArray().Select(f => f.GetString()).ShouldBe(["email"]);
        rows.Single(r => r.GetProperty("line").GetInt32() == 4).GetProperty("reasonCode").GetString().ShouldBe("DUPLICATE_IN_FILE");
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/import/runs/{runId}/rows?action=Rejected&limit=3", Ct)).GetProperty("totalCount").GetInt32().ShouldBe(7);

        // The batch marker lists what the run made and changed: the compensation list.
        var entities = (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/import/runs/{runId}/entities?limit=100", Ct)).GetProperty("items").EnumerateArray().ToList();
        entities.Count(e => e.GetProperty("entityType").GetString() == "Organization" && e.GetProperty("action").GetString() == "Created").ShouldBe(2);
        entities.Count(e => e.GetProperty("entityType").GetString() == "Organization" && e.GetProperty("action").GetString() == "Updated").ShouldBe(1);
        entities.Count(e => e.GetProperty("entityType").GetString() == "Contact").ShouldBe(1);
        entities.Count(e => e.GetProperty("entityType").GetString() == "Affiliation").ShouldBe(1);

        // The same file again returns the stored result and writes nothing: no organization, contact or event twice (AC02).
        var again = await ImportAsync(admin, csv, dryRun: false);
        again.GetProperty("repeated").GetBoolean().ShouldBeTrue();
        again.GetProperty("runId").GetGuid().ShouldBe(runId);
        Counts(again).ShouldBe(Counts(real));
        (await OrganizationCountAsync(admin, marker)).ShouldBe(5);

        var runs = (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/import/runs?limit=200", Ct)).GetProperty("items").EnumerateArray().ToList();
        runs.ShouldContain(r => r.GetProperty("id").GetGuid() == runId && r.GetProperty("mode").GetString() == "Real");
        runs.ShouldContain(r => r.GetProperty("id").GetGuid() == preview.GetProperty("runId").GetGuid() && r.GetProperty("mode").GetString() == "DryRun");

        // A new file that repeats the rows is a new run, and finds nothing left to do.
        var second = await ImportAsync(admin, csv + "\n;;;;;;;;;;;", dryRun: false);
        second.GetProperty("repeated").GetBoolean().ShouldBeFalse();
        (Count(second, "created"), Count(second, "updated"), Count(second, "contacts")).ShouldBe((0, 0, 0));
        (await OrganizationCountAsync(admin, marker)).ShouldBe(5);
    }

    /// <summary>One person in rows of different organizations is one contact with several affiliations; a repeat within the same organization is rejected.</summary>
    internal static async Task SharedContactAcrossOrganizationsAsync(CrmWebFactory factory, HttpClient admin, string marker)
    {
        var lower = marker.ToLowerInvariant();
        var email = $"ola@person-{lower}.no";
        var csv = string.Join('\n',
            "name;orgnr;contactfirstname;contactlastname;contactemail;contactphone",
            $"{marker} A AS;;Ola;Nord;{email};",
            $"{marker} B AS;;;;;",
            $"{marker} C AS;;Ola;Nord;{email};22334455",
            $"{marker} A AS;;Ola;Nord;{email};",
            $"{marker} D AS;;Ola;Nord;{email};99999999");

        var preview = await ImportAsync(admin, csv, dryRun: true);
        var sha = preview.GetProperty("sourceSha256").GetString();
        var real = await ImportAsync(admin, csv, dryRun: false, expectedSha256: sha);
        Counts(real).ShouldBe(Counts(preview), "preview and import count alike: " + real.GetProperty("status").GetString() + " " + real.GetProperty("failureCode").GetString());
        (Count(real, "created"), Count(real, "rejected")).ShouldBe((4, 1));
        real.GetProperty("reasonCounts").GetProperty("DUPLICATE_IN_FILE").GetInt32().ShouldBe(1);
        var rejected = (await AllRowsAsync(admin, real.GetProperty("runId").GetGuid())).Single(r => r.GetProperty("action").GetString() == "Rejected");
        rejected.GetProperty("line").GetInt32().ShouldBe(5);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            var contact = await db.Contacts.Include(c => c.Affiliations).SingleAsync(c => c.Email == email, Ct);
            contact.Phone.ShouldBe("22334455", "a later row only fills gaps");
            var names = await db.Organizations.Where(o => contact.Affiliations.Select(a => a.OrganizationId).Contains(o.Id)).Select(o => o.Name).ToListAsync(Ct);
            names.Order().ShouldBe([$"{marker} A AS", $"{marker} C AS", $"{marker} D AS"]);
        }

        // A repeat of the file changes nothing: not a second contact, not a second affiliation.
        var repeat = await ImportAsync(admin, csv + "\n;;;;;", dryRun: false);
        (Count(repeat, "created"), Count(repeat, "updated")).ShouldBe((0, 0));
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
            (await db.Contacts.Include(c => c.Affiliations).SingleAsync(c => c.Email == email, Ct)).Affiliations.Count.ShouldBe(3);
        }
    }

    [Fact]
    public async Task A_contact_e_mail_repeated_for_another_organization_is_a_second_affiliation_not_a_duplicate()
    {
        var (admin, _, _) = await AdminAsync("dev20-shared-contact");
        await SharedContactAcrossOrganizationsAsync(factory, admin, $"S{Guid.NewGuid():N}"[..9]);
    }

    [Fact]
    public async Task AC04_nothing_a_person_typed_is_changed_by_a_file_that_disagrees_with_every_field()
    {
        var (admin, adminId, _) = await AdminAsync("dev20-typed");
        var (other, otherId, otherEmail) = await AdminAsync("dev20-typed-other");
        _ = other;
        otherId.ShouldNotBe(adminId);
        var marker = $"T{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        var number = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new
        {
            name = $"{marker} Alt AS", orgNumber = number, legalForm = "AS", status = "Customer", naceCode = "62.010", website = $"https://alt-{lower}.no",
            phone = "22000000", email = $"post@alt-{lower}.no", invoiceEmail = $"faktura@alt-{lower}.no", ehfEnabled = true,
            accountManagerId = adminId, primaryTechnicianId = adminId,
            postalAddress = new { street = "Postveien 1", postalCode = "0150", city = "Oslo", countryCode = "NO" },
            visitAddress = new { street = "Besøksveien 2", postalCode = "0151", city = "Oslo", countryCode = "NO" },
            billingAddress = new { street = "Fakturaveien 3", postalCode = "0152", city = "Oslo", countryCode = "NO" },
            domains = new[] { $"alt-{lower}.no" },
        });
        var contactEmail = $"kari@alt-{lower}.no";
        var contact = await admin.PostAsJsonAsync($"{Organizations}/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Nordmann", email = contactEmail, phone = "40000000", mobilePhone = "90000000", preferredLanguage = "nb",
            title = "CTO", roles = new[] { "Technical" }, isPrimary = true,
        }, Ct);
        contact.StatusCode.ShouldBe(HttpStatusCode.Created, await contact.Content.ReadAsStringAsync(Ct));

        async Task<(string Org, string? Etag, string Contacts)> SnapshotAsync()
        {
            var card = await admin.GetAsync($"{Organizations}/{organizationId}", Ct);
            return (await card.Content.ReadAsStringAsync(Ct), card.Headers.ETag?.Tag, await admin.GetStringAsync($"{Organizations}/{organizationId}/contacts", Ct));
        }

        var before = await SnapshotAsync();
        var csv = string.Join('\n',
            "name;orgnr;status;email;phone;website;domain;invoiceemail;ehf;street;postalcode;city;owner;contactfirstname;contactlastname;contactemail;contactphone;contactrole;contacttitle",
            $"{marker} Helt Annet AS;{number};lead;annet@helt-{lower}.no;99999999;https://helt-{lower}.no;helt-{lower}.no;annen@helt-{lower}.no;false;Andre veien 9;9999;Tromsø;{otherEmail};Ola;Hansen;{contactEmail};88888888;decisionmaker;CEO");

        var preview = await ImportAsync(admin, csv, dryRun: true);
        var real = await ImportAsync(admin, csv, dryRun: false, expectedSha256: preview.GetProperty("sourceSha256").GetString());
        Counts(real).ShouldBe(Counts(preview));
        Counts(real).ShouldBe((Created: 0, Updated: 0, Unchanged: 0, Conflicts: 1, Rejected: 0, Contacts: 0, Total: 1));
        var row = real.GetProperty("rows").EnumerateArray().Single();
        row.GetProperty("reasonCode").GetString().ShouldBe("FIELD_CONFLICT");
        row.GetProperty("fieldsChanged").GetArrayLength().ShouldBe(0, "no gap to fill, so nothing was written");
        row.GetProperty("conflictFields").EnumerateArray().Select(f => f.GetString()).ShouldBe(
            ["name", "status", "website", "phone", "email", "invoiceEmail", "accountManager", "postalAddress", "visitAddress", "billingAddress", "domains",
                "contact.firstName", "contact.lastName", "contact.phone", "contact.roles"], ignoreOrder: true);

        // Not one byte of the organization or its contacts changed — not even the row version.
        var after = await SnapshotAsync();
        after.Org.ShouldBe(before.Org);
        after.Etag.ShouldBe(before.Etag);
        after.Contacts.ShouldBe(before.Contacts);

        // Values that agree with the CRM are not a conflict and not a change either.
        var agreeing = string.Join('\n', "name;orgnr;email;phone;contactfirstname;contactlastname;contactemail",
            $"{marker} Alt AS;{number};POST@alt-{lower}.no;+47 22 00 00 00;kari;NORDMANN;{contactEmail}");
        var unchanged = await ImportAsync(admin, agreeing, dryRun: false);
        Counts(unchanged).ShouldBe((Created: 0, Updated: 0, Unchanged: 1, Conflicts: 0, Rejected: 0, Contacts: 0, Total: 1));
        (await SnapshotAsync()).Etag.ShouldBe(before.Etag);
    }

    [Fact]
    public async Task A_contact_without_an_address_is_matched_by_name_filled_never_cleared_and_never_given_a_placeholder_name()
    {
        var (admin, _, _) = await AdminAsync("dev20-contacts");
        var marker = $"C{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        var number = TestData.OrgNumber();
        var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} Kontakt AS", orgNumber = number, status = "Customer" });
        (await admin.PostAsJsonAsync($"{Organizations}/{organizationId}/contacts", new
        {
            firstName = "Kari", lastName = "Nordmann", phone = "40000000", mobilePhone = "90000000", preferredLanguage = "nb", roles = new[] { "Billing" }, isPrimary = true,
        }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Created);

        async Task<List<JsonElement>> ContactsAsync() =>
            (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{organizationId}/contacts", Ct)).EnumerateArray().ToList();

        // A row without e-mail or phone for a person who is already there: not a second contact, nothing cleared.
        var header = "name;orgnr;contactfirstname;contactlastname;contactemail;contactphone";
        var first = await ImportAsync(admin, $"{header}\n{marker} Kontakt AS;{number};Kari;Nordmann;;", dryRun: false);
        Counts(first).ShouldBe((Created: 0, Updated: 0, Unchanged: 1, Conflicts: 0, Rejected: 0, Contacts: 0, Total: 1));
        (await ContactsAsync()).ShouldHaveSingleItem();

        // The same person arrives with an address in a later file: found by name, the address filled, still one contact.
        var second = await ImportAsync(admin, $"{header}\n{marker} Kontakt AS;{number};KARI;nordmann;kari@kontakt-{lower}.no;", dryRun: false);
        Counts(second).ShouldBe((Created: 0, Updated: 1, Unchanged: 0, Conflicts: 0, Rejected: 0, Contacts: 1, Total: 1));
        var contacts = await ContactsAsync();
        var kari = contacts.ShouldHaveSingleItem();
        kari.GetProperty("email").GetString().ShouldBe($"kari@kontakt-{lower}.no");
        var card = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/contacts/{kari.GetProperty("contactId").GetGuid()}", Ct);
        (card.GetProperty("phone").GetString(), card.GetProperty("mobilePhone").GetString(), card.GetProperty("preferredLanguage").GetString())
            .ShouldBe(("40000000", "90000000", "nb"));

        // An address alone names nobody: nothing is invented under "—".
        var third = await ImportAsync(admin, $"{header}\n{marker} Kontakt AS;{number};;;ukjent@kontakt-{lower}.no;", dryRun: false);
        Counts(third).ShouldBe((Created: 0, Updated: 0, Unchanged: 1, Conflicts: 0, Rejected: 0, Contacts: 0, Total: 1));
        third.GetProperty("warningCounts").GetProperty("CONTACT_NAME_MISSING").GetInt32().ShouldBe(1);
        (await ContactsAsync()).ShouldHaveSingleItem();
        await using var scope = factory.Services.CreateAsyncScope();
        (await scope.ServiceProvider.GetRequiredService<CustomersDbContext>().Contacts.IgnoreQueryFilters()
            .CountAsync(c => c.FirstName == "—" || c.LastName == "—", Ct)).ShouldBe(0);
    }

    [Fact]
    public async Task Owners_domains_references_dates_and_near_duplicates_are_checked_and_reported_with_codes()
    {
        var (admin, adminId, adminEmail) = await AdminAsync("dev20-quality");
        var marker = $"Q{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        string parent = TestData.OrgNumber(), child = TestData.OrgNumber(), crmParent = TestData.OrgNumber(), tech = TestData.OrgNumber();
        var ownerless = await admin.CreateOrganizationAsync(new { name = $"{marker} Eierløs AS", orgNumber = tech, status = "Customer" });
        await admin.CreateOrganizationAsync(new { name = $"{marker} Parent i CRM AS", orgNumber = crmParent, status = "Customer" });
        await admin.CreateOrganizationAsync(new { name = $"{marker} Teknologi AS", orgNumber = TestData.OrgNumber(), status = "Customer" });
        var byDomain = await admin.CreateOrganizationAsync(new { name = $"{marker} Domene AS", status = "Customer", domains = new[] { $"kunde-{lower}.no" } });

        var csv = string.Join('\n',
            "name;orgnr;domain;owner;parentorgnr;contractstart;contractend;currency;vatrate;productsku;externalsystem;externalid",
            // Owner resolved, parent earlier in the file, a validated manifest row.
            $"{marker} Mor AS;{parent};https://WWW.Mor-{lower}.no/;{adminEmail};;2026-01-01;2026-12-31;NOK;25;SKU-{lower};oldcrm;K1",
            $"{marker} Datter AS;{child};;{adminEmail};{parent};;;;;;oldcrm;K2",
            // Parent that exists in the CRM; and one that resolves nowhere.
            $"{marker} Datter 2 AS;;;;{crmParent};;;;;;;",
            $"{marker} Foreldreløs AS;;;;{TestData.OrgNumber()};;;;;;;",
            // Dates and codes.
            $"{marker} Datoer AS;;;;;2026-05-01;2026-04-01;;;;;",
            $"{marker} Moms AS;;;;;;;;20;;;",
            $"{marker} Valuta AS;;;;;;;KR;;;;",
            $"{marker} Tvetydig AS;;;;;03/04/2026;;;;;;",
            // The owner of an organization that has none; the organization found by its domain, spelled with a scheme.
            $"{marker} Eierløs AS;{tech};;{adminEmail};;;;;;;;",
            $"{marker} Annet navn;;https://Kunde-{lower}.no/side;;;;;;;;;",
            // Looks like an existing company but is not the same: reported, never merged or linked.
            $"{marker} Teknologi;;;;;;;;;;;",
            // No owner at all.
            $"{marker} Uten eier AS;;;;;;;;;;;");

        var result = await ImportAsync(admin, csv, dryRun: true);
        Counts(result).ShouldBe((Created: 5, Updated: 1, Unchanged: 0, Conflicts: 1, Rejected: 5, Contacts: 0, Total: 12));
        var byLine = result.GetProperty("rows").EnumerateArray().ToDictionary(r => r.GetProperty("line").GetInt32());
        string Reason(int line) => byLine[line].GetProperty("reasonCode").GetString()!;
        Reason(5).ShouldBe("BROKEN_REFERENCE");
        Reason(6).ShouldBe("CONTRACT_DATES_ORDER");
        Reason(7).ShouldBe("INVALID_VAT_RATE");
        Reason(8).ShouldBe("INVALID_CURRENCY");
        Reason(9).ShouldBe("AMBIGUOUS_DATE");
        byLine[10].GetProperty("action").GetString().ShouldBe("Updated");
        byLine[10].GetProperty("fieldsChanged").EnumerateArray().Select(f => f.GetString()).ShouldBe(["accountManager"]);
        byLine[11].GetProperty("action").GetString().ShouldBe("Conflict");
        byLine[11].GetProperty("conflictFields").EnumerateArray().Select(f => f.GetString()).ShouldBe(["name"]);
        byLine[11].GetProperty("organizationId").GetGuid().ShouldBe(byDomain, "matched on the domain even though the file spelled it with a scheme and a path");
        byLine[12].GetProperty("action").GetString().ShouldBe("Created");
        byLine[12].GetProperty("warnings").EnumerateArray().Select(w => w.GetString()).ShouldContain("NEAR_DUPLICATE");
        result.GetProperty("owners").GetProperty("resolved").GetInt32().ShouldBe(3);
        result.GetProperty("owners").GetProperty("empty").GetInt32().ShouldBe(9);
        result.GetProperty("owners").GetProperty("columnPresent").GetBoolean().ShouldBeTrue();
        var validated = result.GetProperty("validatedNotImported");
        validated.GetProperty("currency").GetInt32().ShouldBe(1);
        validated.GetProperty("vatrate").GetInt32().ShouldBe(1);
        validated.GetProperty("contractstart").GetInt32().ShouldBe(1);
        validated.GetProperty("parentorgnumber").GetInt32().ShouldBe(2);
        validated.GetProperty("externalid").GetInt32().ShouldBe(2);
        result.GetProperty("warningCounts").GetProperty("UNKNOWN_PRODUCT").GetInt32().ShouldBe(1, "the SKU is not in the catalog");
        result.GetProperty("warnings").EnumerateArray().ShouldAllBe(w => !w.GetString()!.Contains(marker, StringComparison.OrdinalIgnoreCase));

        var real = await ImportAsync(admin, csv, dryRun: false);
        Counts(real).ShouldBe(Counts(result));
        // Stored as a bare host name, and the similar company is a separate record: the file never links by similar names.
        var mor = (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}%20Mor&limit=10", Ct)).GetProperty("items").EnumerateArray().Single();
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{mor.GetProperty("id").GetGuid()}", Ct)).GetProperty("domains").EnumerateArray()
            .Select(d => d.GetString()).ShouldBe([$"www.mor-{lower}.no"]);
        (await OrganizationCountAsync(admin, $"{marker} Teknologi")).ShouldBe(2);
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/{ownerless}", Ct)).GetProperty("accountManager").GetProperty("id").GetGuid().ShouldBe(adminId);
    }

    [Fact]
    public async Task Encoding_and_structure_problems_reject_only_the_rows_they_touch()
    {
        var (admin, _, _) = await AdminAsync("dev20-encoding");
        var marker = $"E{Guid.NewGuid():N}"[..9];

        // UTF-8 with a BOM and a multi-line quoted value: the lines reported are the lines of the file.
        var good = $"﻿name;note;city\r\n\"{marker} Linje AS\";\"first\r\nsecond\";Bergen\r\n\r\n{marker} Neste AS;x;Oslo\r\n{marker} Skjev AS;x;Oslo;shifted\r\n";
        var utf8 = Encoding.UTF8.GetBytes(good);
        var response = await admin.PostAsync($"{Organizations}/import?dryRun=true", Csv(utf8), Ct);
        var result = await response.ReadJsonAsync();
        Counts(result).ShouldBe((Created: 2, Updated: 0, Unchanged: 0, Conflicts: 0, Rejected: 1, Contacts: 0, Total: 3));
        var rows = result.GetProperty("rows").EnumerateArray().ToList();
        rows.Single(r => r.GetProperty("action").GetString() == "Rejected").GetProperty("line").GetInt32().ShouldBe(6);
        rows.Select(r => r.GetProperty("line").GetInt32()).Order().ToList().ShouldBe([2, 5, 6], "the quoted value spans lines 2-3 and line 4 is blank");
        result.GetProperty("warnings").EnumerateArray().Select(w => w.GetString()).ShouldContain("Column 'note': COLUMN_IGNORED");

        // Latin-1 bytes are not UTF-8: the rows with such a letter are refused, not stored garbled.
        var latin1 = Encoding.Latin1.GetBytes($"name;city\n{marker} Blå AS;Bergen\n{marker} Grønn AS;Oslo\n{marker} Rod AS;Oslo\n");
        var legacy = await (await admin.PostAsync($"{Organizations}/import?dryRun=true", Csv(latin1), Ct)).ReadJsonAsync();
        Counts(legacy).ShouldBe((Created: 1, Updated: 0, Unchanged: 0, Conflicts: 0, Rejected: 2, Contacts: 0, Total: 3));
        legacy.GetProperty("reasonCounts").GetProperty("ENCODING_INVALID").GetInt32().ShouldBe(2);
        legacy.GetProperty("warnings").EnumerateArray().Select(w => w.GetString()).ShouldContain("File: ENCODING_REPLACEMENT_CHARS");
    }

    [Fact]
    public async Task Migration_endpoints_need_the_delete_level_right_and_unknown_runs_are_not_found()
    {
        var sales = factory.ClientAs(CrmRoles.Sales, userKey: "dev20-sales");
        (await PostAsync(sales, "name\nX", dryRun: true)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        foreach (var path in new[] { "import/runs", $"import/runs/{Guid.NewGuid()}", $"import/runs/{Guid.NewGuid()}/rows", $"import/runs/{Guid.NewGuid()}/entities" })
        {
            (await sales.GetAsync($"{Organizations}/{path}", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden, path);
        }

        (await sales.PostAsync($"{Organizations}/import/reconcile", new StringContent("orgnr;period;currency;amount\n", Encoding.UTF8, "text/csv"), Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Forbidden);

        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev20-admin-404");
        foreach (var path in new[] { $"import/runs/{Guid.NewGuid()}", $"import/runs/{Guid.NewGuid()}/rows", $"import/runs/{Guid.NewGuid()}/entities" })
        {
            var missing = await admin.GetAsync($"{Organizations}/{path}", Ct);
            missing.StatusCode.ShouldBe(HttpStatusCode.NotFound, path);
            (await missing.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_IMPORT_RUN_NOT_FOUND");
        }

        // Without the CSRF header a cookie session cannot start an import either.
        var noCsrf = factory.ClientAs(CrmRoles.Admin, userKey: "dev20-admin-csrf", csrf: false);
        var refused = await PostAsync(noCsrf, "name\nX", dryRun: true);
        refused.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await refused.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CSRF_HEADER_REQUIRED");
    }
}

/// <summary>
/// DEV-20-AC04: a failure in the middle of a file keeps the chunks before it, says where it stopped, and the same file
/// resumes without duplicates. A table constraint stands in for a database that refuses one row; it is staged as the
/// administrator, so the class runs alone.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class MigrationImportResumeTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task AC01_a_row_sees_the_rows_before_it_the_same_way_in_a_preview_and_across_chunk_boundaries()
    {
        await using var host = factory.WithWebHostBuilder(b => b.UseSetting("Customers:MigrationChunkSize", "2"));
        var admin = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "dev20-boundary");
        var marker = $"B{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        var csv = string.Join('\n',
            "name;domain",
            $"{marker} A AS;shared-{lower}.no",
            $"{marker} B AS;",
            $"{marker} Annet C;shared-{lower}.no",
            $"{marker} D AS;other-{lower}.no",
            $"{marker} E AS;other-{lower}.no",
            $"{marker} F AS;",
            $"{marker} G AS;same-{lower}.no",
            $"{marker} Annet H;same-{lower}.no");

        var preview = await (await MigrationImportTests.PostAsync(admin, csv, dryRun: true)).ReadJsonAsync();
        var real = await (await MigrationImportTests.PostAsync(admin, csv, dryRun: false, preview.GetProperty("sourceSha256").GetString())).ReadJsonAsync();
        foreach (var counter in new[] { "created", "updated", "unchanged", "conflicts", "rejected", "contacts", "rowsTotal" })
        {
            real.GetProperty(counter).GetInt32().ShouldBe(preview.GetProperty(counter).GetInt32(), counter);
        }

        (real.GetProperty("created").GetInt32(), real.GetProperty("conflicts").GetInt32()).ShouldBe((5, 3));
        real.GetProperty("rows").EnumerateArray().Where(r => r.GetProperty("action").GetString() == "Conflict").Select(r => r.GetProperty("line").GetInt32())
            .Order().ToList().ShouldBe([4, 6, 9], "a conflict with a row of the same chunk and with rows of earlier chunks");
        (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}&limit=50", Ct)).GetProperty("items").GetArrayLength().ShouldBe(5);
    }

    [Fact]
    public async Task A_contact_shared_by_organizations_in_different_chunks_gets_every_affiliation()
    {
        await using var host = factory.WithWebHostBuilder(b => b.UseSetting("Customers:MigrationChunkSize", "2"));
        var admin = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "dev20-shared-chunk");
        await MigrationImportTests.SharedContactAcrossOrganizationsAsync(factory, admin, $"K{Guid.NewGuid():N}"[..9]);
    }

    [Fact]
    public async Task AC04_a_chunk_that_fails_leaves_the_earlier_chunks_and_the_same_file_resumes_after_them()
    {
        await using var host = factory.WithWebHostBuilder(b => b.UseSetting("Customers:MigrationChunkSize", "2"));
        var admin = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "dev20-resume");
        var marker = $"R{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        var constraint = $"CK_dev20_{marker}";
        var csv = new StringBuilder("name;contactfirstname;contactlastname;contactemail\n");
        for (var i = 1; i <= 7; i++)
        {
            csv.Append($"{marker} {(i == 5 ? "POISON" : "Rad")} {i} AS;Ola;Nord{i};c{i}@resume-{lower}.no\n");
        }

        await factory.AdminSqlAsync($"ALTER TABLE customers.Organizations ADD CONSTRAINT [{constraint}] CHECK (Name NOT LIKE N'%{marker} POISON%')");
        try
        {
            var preview = await (await MigrationImportTests.PostAsync(admin, csv.ToString(), dryRun: true)).ReadJsonAsync();
            preview.GetProperty("created").GetInt32().ShouldBe(7, "a preview cannot know what the database will refuse");

            // Chunks of two rows: lines 2-3 and 4-5 commit, lines 6-7 fail as a whole, line 8 is never reached.
            var partial = await (await MigrationImportTests.PostAsync(admin, csv.ToString(), dryRun: false, preview.GetProperty("sourceSha256").GetString())).ReadJsonAsync();
            partial.GetProperty("status").GetString().ShouldBe("Partial");
            partial.GetProperty("failureCode").GetString().ShouldBe("IMPORT_CHUNK_FAILED");
            partial.GetProperty("lastCommittedLine").GetInt32().ShouldBe(5);
            (partial.GetProperty("failedFromLine").GetInt32(), partial.GetProperty("failedToLine").GetInt32()).ShouldBe((6, 7));
            partial.GetProperty("created").GetInt32().ShouldBe(4);
            var runId = partial.GetProperty("runId").GetGuid();

            await using (var scope = factory.Services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
                (await db.Organizations.CountAsync(o => o.Name.Contains(marker), Ct)).ShouldBe(4);
                var contacts = await db.Contacts.Include(c => c.Affiliations).Where(c => c.Email!.Contains(lower)).ToListAsync(Ct);
                contacts.Count.ShouldBe(4, "the failed chunk left no contact behind");
                contacts.ShouldAllBe(c => c.Affiliations.Count == 1, "every contact kept is affiliated, none half-linked");
                (await db.ImportRowOutcomes.CountAsync(o => o.RunId == runId, Ct)).ShouldBe(4, "the failed chunk wrote no outcome either");
                var affiliated = contacts.Select(c => c.Affiliations.Single().OrganizationId).ToList();
                (await db.Organizations.CountAsync(o => affiliated.Contains(o.Id), Ct)).ShouldBe(4);
            }

            // The database accepts the file now: the same call resumes after line 5 and finishes without a duplicate.
            await factory.AdminSqlAsync($"ALTER TABLE customers.Organizations DROP CONSTRAINT [{constraint}]");
            var resumed = await (await MigrationImportTests.PostAsync(admin, csv.ToString(), dryRun: false)).ReadJsonAsync();
            resumed.GetProperty("status").GetString().ShouldBe("Completed");
            resumed.GetProperty("runId").GetGuid().ShouldBe(runId);
            resumed.GetProperty("repeated").GetBoolean().ShouldBeFalse();
            resumed.GetProperty("lastCommittedLine").GetInt32().ShouldBe(8);
            (resumed.GetProperty("created").GetInt32(), resumed.GetProperty("rowsTotal").GetInt32(), resumed.GetProperty("contacts").GetInt32()).ShouldBe((7, 7, 7));
            resumed.GetProperty("failedFromLine").ValueKind.ShouldBe(JsonValueKind.Null);
            (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}&limit=50", Ct)).GetProperty("items").GetArrayLength().ShouldBe(7);

            var rows = new List<int>();
            var page = await admin.GetFromJsonAsync<JsonElement>($"{Organizations}/import/runs/{runId}/rows?limit=200", Ct);
            rows.AddRange(page.GetProperty("items").EnumerateArray().Select(r => r.GetProperty("line").GetInt32()));
            rows.ShouldBe(Enumerable.Range(2, 7));

            // Done is done: a third call returns the stored result.
            var thirdResponse = await MigrationImportTests.PostAsync(admin, csv.ToString(), dryRun: false);
            thirdResponse.StatusCode.ShouldBe(HttpStatusCode.OK, await thirdResponse.Content.ReadAsStringAsync(Ct));
            var third = await thirdResponse.ReadJsonAsync();
            third.GetProperty("repeated").GetBoolean().ShouldBeTrue();
            (await admin.GetFromJsonAsync<JsonElement>($"{Organizations}?search={marker}&limit=50", Ct)).GetProperty("items").GetArrayLength().ShouldBe(7);
        }
        finally
        {
            await factory.AdminSqlAsync(
                $"IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'{constraint}') ALTER TABLE customers.Organizations DROP CONSTRAINT [{constraint}]");
        }
    }
}
