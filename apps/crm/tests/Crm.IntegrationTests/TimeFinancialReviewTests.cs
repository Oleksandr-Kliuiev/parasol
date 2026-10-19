using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Infrastructure.Persistence;
using Crm.Authorization;
using Crm.Billing.Contracts;
using Crm.Billing.Persistence;
using Crm.Contracts.Contracts;
using Crm.Contracts.Persistence;
using Crm.TimeTracking.Contracts;
using Crm.TimeTracking.Domain;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimeBankTestSupport;
using static Crm.IntegrationTests.TimeBillingTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

// Historical fixtures deliberately leave events undelivered; other test classes drain the shared outbox.
[Collection(DatabaseAdministrationCollection.Name)]
public sealed class TimeFinancialReviewTests(CrmWebFactory factory)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static string Route(Guid entry) => $"/api/v1/time/entries/{entry}/financial-review";

    [Theory]
    [InlineData(CrmRoles.Admin)] [InlineData(CrmRoles.Finance)] [InlineData(CrmRoles.Management)]
    public async Task Authorized_review_reads_actual_bank_facts_without_changing_versions_audit_outbox_or_balances(string role)
    {
        var (_, employee, bank, entry, _) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var before = await Snapshot(entry, bank);
        using var client = factory.ClientAs(role);
        for (var refresh = 0; refresh < 2; refresh++)
        {
            using var response = await client.GetAsync(Route(entry), Ct); response.StatusCode.ShouldBe(HttpStatusCode.OK);
            response.Headers.CacheControl!.NoStore.ShouldBeTrue();
            var report = (await response.Content.ReadFromJsonAsync<TimeFinancialReview>(Json, Ct))!;
            report.EntryId.ShouldBe(entry); report.RequiresReview.ShouldBeFalse(); report.Status.ShouldBe(TimeEntryStatus.Approved);
            report.Banks.ShouldHaveSingleItem().NetHours.ShouldBe(2m); report.Banks.Single().AllocatedHours.ShouldBe(2m);
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(Ct));
            var keys = Keys(json.RootElement).ToHashSet(StringComparer.OrdinalIgnoreCase);
            keys.ShouldNotContain("amount"); keys.ShouldNotContain("rate"); keys.ShouldNotContain("sourceId"); keys.ShouldNotContain("externalId");
        }
        (await Snapshot(entry, bank)).ShouldBe(before);
    }

    [Theory]
    [InlineData(CrmRoles.ServiceLead)] [InlineData(CrmRoles.Sales)] [InlineData(CrmRoles.Technician)] [InlineData(CrmRoles.ReadOnly)]
    public async Task Other_roles_cannot_probe_financial_review_even_when_they_read_time_or_prices_elsewhere(string role)
    {
        using var client = factory.ClientAs(role);
        (await client.GetAsync(Route(Guid.NewGuid()), Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Missing_entries_are_not_reported_as_clear_financial_history()
    {
        using var client = factory.ClientAs(CrmRoles.Finance);
        (await client.GetAsync(Route(Guid.NewGuid()), Ct)).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Orphan_next_approval_consumption_in_a_closed_bank_is_visible_without_a_saved_review_note_or_repair()
    {
        var (_, _, bank, entry, date) = await Setup(factory, 2);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<IContractsApi>().ConsumeHoursAsync(bank, 1m, date, "Synthetic historical orphan", "TimeEntry", $"{entry}:1:{bank}", Ct);
            var db = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
            (await db.HourBanks.SingleAsync(b => b.Id == bank, Ct)).Close(); await db.SaveChangesAsync(Ct);
        }
        var before = await Snapshot(entry, bank); using var client = factory.ClientAs(CrmRoles.Finance);
        var report = (await client.GetFromJsonAsync<TimeFinancialReview>(Route(entry), Json, Ct))!;
        report.ReviewNote.ShouldBeNull(); report.RequiresReview.ShouldBeTrue();
        report.Findings.ShouldContain(f => f.Code == "BANK_PENDING_APPROVAL");
        report.Findings.ShouldContain(f => f.Code == "BANK_ALLOCATION_MISMATCH");
        report.Banks.ShouldHaveSingleItem().State.ShouldBe("Closed"); report.Banks.Single().NetHours.ShouldBe(1m);
        report.Status.ShouldBe(TimeEntryStatus.New); (await Snapshot(entry, bank)).ShouldBe(before);
    }

    [Fact]
    public async Task A_foreign_bank_receipt_is_explicit_and_does_not_disclose_its_name_or_link_as_an_available_bank()
    {
        var (_, _, _, entry, date) = await Setup(factory, 2); var foreign = await Organization(factory); Guid bank;
        using (var admin = factory.ClientAs(CrmRoles.Admin))
        {
            using var created = await admin.PostAsJsonAsync("/api/v1/contracts/hour-banks", new { organizationId = foreign,
                name = "Synthetic private foreign bank marker", hours = 10m, validFrom = date.AddYears(-1) }, Ct);
            created.EnsureSuccessStatusCode(); bank = (await created.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();
        }
        await using (var scope = factory.Services.CreateAsyncScope())
            await scope.ServiceProvider.GetRequiredService<IContractsApi>().ConsumeHoursAsync(bank, 1m, date, "Synthetic misplaced reference", "TimeEntry", $"{entry}:1:{bank}", Ct);
        using var client = factory.ClientAs(CrmRoles.Finance);
        var report = (await client.GetFromJsonAsync<TimeFinancialReview>(Route(entry), Json, Ct))!;
        var row = report.Banks.ShouldHaveSingleItem(); row.Available.ShouldBeFalse(); row.Name.ShouldBeNull(); row.State.ShouldBe("OtherOrganization");
        report.Findings.ShouldContain(f => f.Code == "BANK_REFERENCE_UNAVAILABLE");
    }

    [Fact]
    public async Task A_legacy_new_revision_points_to_the_exact_exported_basis_and_requires_review_without_marking_it_invoiced()
    {
        var (org, employee, bank, entry, date) = await Setup(factory, 2); await ApproveTime(factory, employee, entry);
        var draft = await Prepare(factory, org, entry, date); var finance = await Employee(factory, CrmRoles.Finance); await ApproveBilling(factory, finance, draft);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var billing = scope.ServiceProvider.GetRequiredService<IBillingApi>();
            (await billing.MarkExportSendingAsync(draft.Basis, "synthetic", null, Ct)).ShouldBeTrue();
            await billing.MarkExportedAsync(draft.Basis, "synthetic", "1", null, Ct);
            var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            var row = await db.TimeEntries.Include(e => e.Allocations).SingleAsync(e => e.Id == entry, Ct);
            row.Withdraw().IsSuccess.ShouldBeTrue();
            var next = new TimeAllocation(entry, TimeClassification.Rate, 2m, 2m, 100m, null);
            row.Approve(employee, DateTimeOffset.UtcNow, null, [next]); db.TimeAllocations.Add(next); await db.SaveChangesAsync(Ct);
        }
        var before = await Snapshot(entry, bank); using var client = factory.ClientAs(CrmRoles.Finance);
        var report = (await client.GetFromJsonAsync<TimeFinancialReview>(Route(entry), Json, Ct))!;
        report.Findings.ShouldContain(f => f.Code == "BILLING_SOURCE_UNPROVEN");
        var basis = report.Billing.ShouldHaveSingleItem(); basis.BasisId.ShouldBe(draft.Basis); basis.Exported.ShouldBeTrue(); basis.CurrentRevision.ShouldBeFalse();
        report.Status.ShouldBe(TimeEntryStatus.Approved); (await Snapshot(entry, bank)).ShouldBe(before);
    }

    [Fact]
    public async Task Saved_review_filter_keeps_full_totals_and_cursor_paging_and_does_not_broaden_technician_scope()
    {
        var date = TimePeriodTestSupport.Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        var other = await Seed(factory, org, employee, date); var clear = await Seed(factory, org, employee, date);
        using var technician = factory.ClientAs(CrmRoles.Technician, "m26-own-" + Guid.NewGuid().ToString("N"));
        using var created = await technician.PostAsJsonAsync("/api/v1/time/entries", Request(org, date, Guid.NewGuid()), Ct);
        created.EnsureSuccessStatusCode(); var own = (await created.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
            foreach (var row in await db.TimeEntries.Where(e => e.Id == own || e.Id == other.Id).ToListAsync(Ct)) row.FlagForReview("Synthetic saved review");
            await db.SaveChangesAsync(Ct);
        }
        var path = $"/api/v1/time/entries?year={date.Year}&month={date.Month}&organizationId={org}&reviewOnly=true&limit=1";
        using var finance = factory.ClientAs(CrmRoles.Finance);
        var first = (await finance.GetFromJsonAsync<TimeEntryPage>(path, Json, Ct))!;
        first.TotalCount.ShouldBe(2); first.Summary.Hours.ShouldBe(2m); first.Items.Count.ShouldBe(1); first.NextCursor.ShouldNotBeNull();
        var second = (await finance.GetFromJsonAsync<TimeEntryPage>(path + "&cursor=" + Uri.EscapeDataString(first.NextCursor), Json, Ct))!;
        first.Items.Concat(second.Items).Select(e => e.Id).Order().ShouldBe(new[] { own, other.Id }.Order()); second.NextCursor.ShouldBeNull();
        first.Items.Concat(second.Items).ShouldNotContain(e => e.Id == clear.Id);
        var scoped = (await technician.GetFromJsonAsync<TimeEntryPage>(path, Json, Ct))!;
        scoped.TotalCount.ShouldBe(1); scoped.Items.ShouldHaveSingleItem().Id.ShouldBe(own); scoped.Summary.Hours.ShouldBe(1m);
    }

    [Fact]
    public async Task Cancellation_during_a_source_read_releases_the_real_time_lease_without_a_partial_clear_report()
    {
        var (_, _, _, entry, date) = await Setup(factory, 2); var finance = await Employee(factory, CrmRoles.Finance);
        var api = DispatchProxy.Create<IContractsApi, BankReadGate>(); var gate = (BankReadGate)api;
        await using var host = Host(factory, finance, CrmRoles.Finance, services => services.AddScoped(_ => api));
        await using var scope = host.Services.CreateAsyncScope(); using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        var pending = scope.ServiceProvider.GetRequiredService<TimeFinancialReviewService>().ReadAsync(entry, cancel.Token);
        try { await gate.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10), Ct); (await Probe(factory, date, "Exclusive")).ShouldBe(-1); }
        finally { cancel.Cancel(); }
        await Should.ThrowAsync<OperationCanceledException>(() => pending); (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }

    private async Task<string> Snapshot(Guid entry, Guid bank)
    {
        await using var scope = factory.Services.CreateAsyncScope(); var time = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var contracts = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var row = await time.TimeEntries.SingleAsync(e => e.Id == entry, Ct); var balance = await contracts.HourBanks.SingleAsync(b => b.Id == bank, Ct);
        var billing = scope.ServiceProvider.GetRequiredService<BillingDbContext>();
        var ids = (await scope.ServiceProvider.GetRequiredService<ITimeBillingReader>().ReadAsync([new(entry, row.OrganizationId)], Ct)).Select(c => c.BasisId).Distinct().ToList();
        var bases = await billing.BillingBases.Where(b => ids.Contains(b.Id)).OrderBy(b => b.Id).ToListAsync(Ct);
        return JsonSerializer.Serialize(new { timeVersion = time.GetETag(row), bankVersion = contracts.GetETag(balance), row.Status, row.Hours, balance.UsedHours,
            timeAudit = await time.AuditEntries.CountAsync(a => a.EntityId == entry, Ct), bankAudit = await contracts.AuditEntries.CountAsync(a => a.EntityId == bank, Ct),
            timeOutbox = await time.OutboxMessages.CountAsync(o => o.Payload.Contains(entry.ToString()), Ct),
            bankOutbox = await contracts.OutboxMessages.CountAsync(o => o.Payload.Contains(bank.ToString()), Ct),
            billingVersions = bases.ToDictionary(b => b.Id, b => billing.GetETag(b)),
            billingAudit = await billing.AuditEntries.CountAsync(a => ids.Contains(a.EntityId), Ct),
            billingOutbox = await billing.OutboxMessages.CountAsync(Ct),
            movements = await contracts.HourBankEntries.CountAsync(e => e.HourBankId == bank, Ct) });
    }

    private static IEnumerable<string> Keys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var property in value.EnumerateObject()) { yield return property.Name; foreach (var child in Keys(property.Value)) yield return child; }
        if (value.ValueKind == JsonValueKind.Array) foreach (var child in value.EnumerateArray()) foreach (var name in Keys(child)) yield return name;
    }

    public class BankReadGate : DispatchProxy
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<IReadOnlyList<SourceBankUsage>> rows = new(TaskCreationOptions.RunContinuationsAsynchronously);
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod?.Name != nameof(IContractsApi.GetSourceBankUsageAsync)) throw new InvalidOperationException("Unexpected contract read.");
            Entered.TrySetResult(); return rows.Task.WaitAsync((CancellationToken)args![2]!);
        }
    }
}
