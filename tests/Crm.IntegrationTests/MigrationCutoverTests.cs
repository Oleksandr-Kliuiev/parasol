using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Customers.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-20 cutover: the reconciliation of the old system's totals against the charge register (read-only), and the first-load
/// import of external records, whose preview must count what the real run does. Staging billing history and a table constraint
/// is the database administrator's work, so the class runs alone.
/// </summary>
[Collection(DatabaseAdministrationCollection.Name)]
public sealed partial class MigrationCutoverTests(CrmWebFactory factory)
{
    private const string Organizations = "/api/v1/customers/organizations";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [GeneratedRegex(@"^(Customer|Contact)/[a-z0-9]+: [A-Z_]+$|^Summary: ([A-Z_]+=\d+(, )?)+$")]
    private static partial Regex SafeError();

    private static async Task<JsonElement> ReconcileAsync(HttpClient admin, string csv)
    {
        var response = await admin.PostAsync($"{Organizations}/import/reconcile", new StringContent(csv, new UTF8Encoding(false), "text/csv"), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    [Fact]
    public async Task AC03_the_old_systems_totals_are_reconciled_per_customer_month_and_currency_and_a_changed_amount_or_missing_customer_is_flagged()
    {
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: "dev20-reconcile");
        var marker = $"V{Guid.NewGuid():N}"[..9];
        string nA = TestData.OrgNumber(), nB = TestData.OrgNumber(), nC = TestData.OrgNumber(), nX = TestData.OrgNumber();
        var a = await admin.CreateOrganizationAsync(new { name = $"{marker} Avstemt A AS", orgNumber = nA, status = "Customer" });
        var b = await admin.CreateOrganizationAsync(new { name = $"{marker} Avstemt B AS", orgNumber = nB, status = "Customer" });
        var c = await admin.CreateOrganizationAsync(new { name = $"{marker} Avstemt C AS", orgNumber = nC, status = "Customer" });

        // A closed month of an earlier version and what was billed in them, staged as the administrator (billing is guarded).
        var march = Guid.NewGuid();
        await factory.AdminSqlWithoutBillingTriggersAsync($"""
            INSERT INTO billing.BillingRuns (Id, PeriodStart, PeriodEnd, Kind, Status, CollectedAt, ApprovedAt, RequiresSecondApproval, ExportedAt, ClosedAt, Notes, ContentRevision, ApprovedRevision, ApprovedDigest, CreatedAt, IsDeleted)
            VALUES ({march}, {new DateOnly(2037, 3, 1)}, {new DateOnly(2037, 3, 31)}, N'Regular', N'Closed', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), {marker}, 0, 0, N'test', SYSDATETIMEOFFSET(), 0);
            INSERT INTO billing.Charges (Id, [Key], Kind, SourceOrganizationId, PayerOrganizationId, Currency, Amount, Status, RunId, StatusChangedAt, CreatedAt, IsDeleted)
            VALUES (NEWID(), {$"{marker}:a-nok"}, N'Contract', {a}, {a}, N'NOK', 1000, N'ExportConfirmed', {march}, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0),
                   (NEWID(), {$"{marker}:a-eur"}, N'Contract', {a}, {a}, N'EUR', 200, N'ExportConfirmed', {march}, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0),
                   (NEWID(), {$"{marker}:b-nok"}, N'Contract', {b}, {b}, N'NOK', 500, N'ExportConfirmed', {march}, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0),
                   (NEWID(), {$"{marker}:b-legacy"}, N'Legacy', {b}, {b}, N'NOK', 70, N'LegacyUnresolved', {march}, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0),
                   (NEWID(), {$"{marker}:c-eur"}, N'Contract', {c}, {c}, N'EUR', 300, N'ExportConfirmed', {march}, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0);
            """);

        var file = string.Join('\n',
            "orgnr;period;currency;amount",
            $"{nA};2037-03;NOK;1000",
            $"{nA};2037-03;eur;200,00",
            $"{nB};2037-03;NOK;450",
            $"{nC};2037-03;NOK;300",
            $"{nX};2037-03;NOK;10",
            "123456789;2037-03;NOK;1",
            $"{nA};2037-13;NOK;5");
        var result = await ReconcileAsync(admin, file);

        result.GetProperty("amountsVisible").GetBoolean().ShouldBeTrue();
        result.GetProperty("customers").GetInt32().ShouldBe(3, "the unknown customer is not counted as found");
        var counts = result.GetProperty("statusCounts");
        (counts.GetProperty("Matched").GetInt32(), counts.GetProperty("Different").GetInt32(), counts.GetProperty("MissingInCrm").GetInt32(),
            counts.GetProperty("MissingInFile").GetInt32(), counts.GetProperty("MissingCustomer").GetInt32(), counts.GetProperty("Rejected").GetInt32())
            .ShouldBe((2, 1, 1, 1, 1, 2));

        var lines = result.GetProperty("lines").EnumerateArray().ToList();
        JsonElement Line(string orgNumber, string period, string currency) =>
            lines.Single(l => l.GetProperty("orgNumber").ValueKind == JsonValueKind.String && l.GetProperty("orgNumber").GetString() == orgNumber &&
                              l.GetProperty("period").GetString() == period && l.GetProperty("currency").GetString() == currency);

        Line(nA, "2037-03", "NOK").GetProperty("status").GetString().ShouldBe("Matched");
        Line(nA, "2037-03", "EUR").GetProperty("status").GetString().ShouldBe("Matched");
        var changed = Line(nB, "2037-03", "NOK");
        changed.GetProperty("status").GetString().ShouldBe("Different");
        (changed.GetProperty("fileAmount").GetDecimal(), changed.GetProperty("crmBilled").GetDecimal(), changed.GetProperty("difference").GetDecimal())
            .ShouldBe((450m, 500m, -50m));
        changed.GetProperty("crmUnconfirmed").GetDecimal().ShouldBe(70m, "a legacy line is shown, never counted as billed");
        Line(nC, "2037-03", "NOK").GetProperty("status").GetString().ShouldBe("MissingInCrm", "the old system has NOK where the CRM billed EUR");
        var unlisted = Line(nC, "2037-03", "EUR");
        unlisted.GetProperty("status").GetString().ShouldBe("MissingInFile");
        unlisted.GetProperty("crmBilled").GetDecimal().ShouldBe(300m);
        Line(nX, "2037-03", "NOK").GetProperty("status").GetString().ShouldBe("MissingCustomer");
        lines.Where(l => l.GetProperty("status").GetString() == "Rejected").Select(l => l.GetProperty("reasonCode").GetString())
            .ShouldBe(["INVALID_ORGNR", "INVALID_PERIOD"], ignoreOrder: true);

        // Reading changed nothing in billing.
        await using var scope = factory.Services.CreateAsyncScope();
        var billing = scope.ServiceProvider.GetRequiredService<Crm.Billing.Persistence.BillingDbContext>();
        (await billing.Charges.CountAsync(x => x.SourceOrganizationId == a || x.SourceOrganizationId == b || x.SourceOrganizationId == c, Ct)).ShouldBe(5);

        // A file without the needed columns is refused with a reason.
        var invalid = await admin.PostAsync($"{Organizations}/import/reconcile", new StringContent("orgnr;amount\n1;2", Encoding.UTF8, "text/csv"), Ct);
        invalid.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await invalid.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CUS_RECONCILIATION_INVALID");
    }

    [Fact]
    public async Task AC01_a_preview_of_external_records_counts_what_the_import_then_does_and_errors_carry_codes_not_names()
    {
        var marker = $"X{Guid.NewGuid():N}"[..9];
        var lower = marker.ToLowerInvariant();
        var admin = factory.ClientAs(CrmRoles.Admin, userKey: $"dev20-ext-{lower}");
        var number = TestData.OrgNumber();
        var existing = await admin.CreateOrganizationAsync(new { name = $"{marker} Eksisterende AS", orgNumber = number, status = "Customer" });
        await admin.CreateOrganizationAsync(new { name = $"{marker} Tvetydig AS", status = "Customer" });
        var knownEmail = $"eks-{lower}@example.no";
        (await admin.PostAsJsonAsync($"{Organizations}/{existing}/contacts", new { firstName = "Eva", lastName = "Eksisterende", email = knownEmail, roles = Array.Empty<string>(), isPrimary = true }, Ct))
            .StatusCode.ShouldBe(HttpStatusCode.Created);

        // A person who has been erased at their request: their address is suppressed.
        var person = await PrivacyTestData.PersonAsync(factory);
        var privacyAdmin = factory.ClientAs(CrmRoles.Admin, userKey: $"prv-sync-{person.Marker.ToLowerInvariant()}");
        var (caseId, etag) = await PrivacyTests.OpenAsync(privacyAdmin, "Erasure", "Contact", person.ContactId);
        etag = await PrivacyTests.VerifyAsync(privacyAdmin, caseId, etag);
        var plan = await PrivacyTests.PreviewAsync(privacyAdmin, caseId, etag);
        var caseNumber = (await privacyAdmin.GetFromJsonAsync<JsonElement>($"/api/v1/privacy/cases/{caseId}", Ct)).GetProperty("number").GetString()!;
        (await PrivacyTests.ExecuteRawAsync(privacyAdmin, caseId, plan.Etag, plan.Digest, caseNumber)).StatusCode.ShouldBe(HttpStatusCode.OK);

        await using var host = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddSingleton<IIntegrationAdapter, FakeExternalAdapter>()));
        await using var scope = host.Services.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<ExternalRecordStore>();
        var import = scope.ServiceProvider.GetRequiredService<ExternalImportService>();
        var integration = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        const string system = FakeExternalAdapter.SystemName;

        Task Put(string type, string id, string display, object payload, string? orgNumber = null, string? parent = null, string? email = null) =>
            store.UpsertAsync(new ExternalRecordInput(system, type, id, display, payload, OrgNumber: orgNumber, Email: email, ParentExternalId: parent), Ct);

        await Put("Customer", "c1", $"{marker} Ny AS", new { name = $"{marker} Ny AS" });
        await Put("Customer", "c2", $"{marker} Eksisterende AS", new { name = $"{marker} Eksisterende AS", orgNumber = number }, orgNumber: number);
        await Put("Customer", "c3", $"{marker} Tvetydig", new { name = $"{marker} Tvetydig" });
        await Put("Customer", "c4", $"{marker} Uten navn", new { name = "" });
        await Put("Customer", "c5", $"{marker} Ny To AS", new { name = $"{marker} Ny To AS" });

        async Task<BulkResult> RunAsync(string type, bool dryRun)
        {
            var outcome = await import.ImportUnlinkedAsync(system, type, dryRun, Ct);
            outcome.IsSuccess.ShouldBeTrue();
            return outcome.Value;
        }

        static (int Linked, int Created, int Skipped, int Failed) Tally(BulkResult r) => (r.Linked, r.Created, r.Skipped, r.Failed);

        var customerPreview = await RunAsync("Customer", dryRun: true);
        (await integration.ExternalLinks.CountAsync(l => l.System == system, Ct)).ShouldBe(0, "the preview linked nothing");
        var customers = await RunAsync("Customer", dryRun: false);
        Tally(customerPreview).ShouldBe((Linked: 1, Created: 2, Skipped: 1, Failed: 1));
        Tally(customers).ShouldBe(Tally(customerPreview), "the preview counts what the import does");
        (await integration.ExternalLinks.CountAsync(l => l.System == system, Ct)).ShouldBe(3);

        await Put("Contact", "k1", $"Ny Person {marker}", new { first = "Nora", last = marker, email = $"ny-{lower}@example.no" }, parent: "c1", email: $"ny-{lower}@example.no");
        await Put("Contact", "k2", $"Kjent Person {marker}", new { first = "Eva", last = marker, email = knownEmail }, parent: "c1", email: knownEmail);
        await Put("Contact", "k3", $"Foreldreløs {marker}", new { first = "Per", last = marker, email = $"per-{lower}@example.no" }, parent: "c3", email: $"per-{lower}@example.no");
        await Put("Contact", "k4", $"Slettet {marker}", new { first = person.FirstName, last = person.LastName, email = person.Email }, parent: "c1", email: person.Email);
        await Put("Contact", "k5", $"Ulesbar {marker}", new { broken = true }, parent: "c1");

        var contactPreview = await RunAsync("Contact", dryRun: true);
        var contacts = await RunAsync("Contact", dryRun: false);
        Tally(contactPreview).ShouldBe((Linked: 1, Created: 1, Skipped: 1, Failed: 2));
        Tally(contacts).ShouldBe(Tally(contactPreview));

        foreach (var error in customers.Errors.Concat(contacts.Errors).Concat(customerPreview.Errors).Concat(contactPreview.Errors))
        {
            error.ShouldMatch(SafeError().ToString());
            error.ShouldNotContain(marker, Case.Insensitive);
            error.ShouldNotContain(person.FirstName, Case.Insensitive);
            error.ShouldNotContain(person.Email, Case.Insensitive);
        }

        contacts.Errors.ShouldContain("Contact/k4: PRV_SUPPRESSED");
        contacts.Errors.ShouldContain("Contact/k5: INT_IMPORT_FAILED");
        await using (var data = host.Services.CreateAsyncScope())
        {
            var crm = data.ServiceProvider.GetRequiredService<CustomersDbContext>();
            (await crm.Organizations.CountAsync(o => o.Name.Contains(marker), Ct)).ShouldBe(4, "two existed, two were made");
            (await crm.Contacts.CountAsync(c => c.Email!.Contains(lower), Ct)).ShouldBe(2, "the known contact and one new one; the erased person did not come back");
            (await crm.Contacts.IgnoreQueryFilters().CountAsync(c => c.Email == person.Email, Ct)).ShouldBe(0);
        }

        // A record the database refuses fails alone: the run goes on, nothing half-made is left behind, and the summary counts it.
        var constraint = $"CK_dev20x_{marker}";
        await Put("Customer", "p1", $"{marker} POISON AS", new { name = $"{marker} POISON AS" });
        await Put("Customer", "p2", $"{marker} Z Gyldig AS", new { name = $"{marker} Z Gyldig AS" });
        await factory.AdminSqlAsync($"ALTER TABLE customers.Organizations ADD CONSTRAINT [{constraint}] CHECK (Name NOT LIKE N'%{marker} POISON%')");
        try
        {
            var refused = await RunAsync("Customer", dryRun: false);
            Tally(refused).ShouldBe((Linked: 0, Created: 1, Skipped: 1, Failed: 2));
            refused.Errors.ShouldContain("Customer/p1: INT_IMPORT_DB_FAILED");
            refused.Errors[^1].ShouldBe("Summary: INT_IMPORT_DB_FAILED=1, INT_IMPORT_FAILED=1");
            refused.Errors.ShouldAllBe(e => SafeError().IsMatch(e) && !e.Contains(marker, StringComparison.OrdinalIgnoreCase));
            await using var after = host.Services.CreateAsyncScope();
            (await after.ServiceProvider.GetRequiredService<CustomersDbContext>().Organizations.CountAsync(o => o.Name.Contains($"{marker} Z Gyldig"), Ct)).ShouldBe(1);
        }
        finally
        {
            await factory.AdminSqlAsync($"IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N'{constraint}') ALTER TABLE customers.Organizations DROP CONSTRAINT [{constraint}]");
        }

        // A link that cannot be made is a failure, counted as one: the customer is already linked to another record.
        await Put("Customer", "c6", $"{marker} Samme nummer", new { name = $"{marker} Samme nummer", orgNumber = number }, orgNumber: number);
        var auto = await import.AutoLinkAsync(system, "Customer", Ct);
        auto.IsSuccess.ShouldBeTrue();
        (auto.Value.Linked, auto.Value.Failed).ShouldBe((0, 1));
        auto.Value.Errors.ShouldContain("Customer/c6: INT_ENTITY_ALREADY_LINKED");
        auto.Value.Errors.ShouldAllBe(e => !e.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>An adapter of a system of its own, so the import above sees no record of any other test.</summary>
internal sealed class FakeExternalAdapter : IIntegrationAdapter
{
    public const string SystemName = "fakedev20";

    public string System => SystemName;

    public bool IsEnabled => true;

    public IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; } =
    [
        new(SystemName, "Customer", EntityTypes.Organization),
        new(SystemName, "Contact", EntityTypes.Contact, "Customer"),
    ];

    public string? CreateOrganizationOperation => null;

    public ExternalOrganizationData? ToOrganizationData(ExternalRecord record)
    {
        var payload = JsonDocument.Parse(record.Payload).RootElement;
        return new ExternalOrganizationData(
            payload.GetProperty("name").GetString() ?? string.Empty,
            payload.TryGetProperty("orgNumber", out var number) ? number.GetString() : null,
            null, null, null, [], null, null, null);
    }

    public ExternalContactData? ToContactData(ExternalRecord record)
    {
        var payload = JsonDocument.Parse(record.Payload).RootElement;
        return payload.TryGetProperty("broken", out _)
            ? null
            : new ExternalContactData(payload.GetProperty("first").GetString()!, payload.GetProperty("last").GetString()!, payload.GetProperty("email").GetString(), null, null, null);
    }

    public Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken) => Task.FromResult(new ConnectionTestResult(true, "ok"));
}
