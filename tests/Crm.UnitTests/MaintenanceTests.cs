using System.Runtime.CompilerServices;
using Crm.Infrastructure.Documents;
using Crm.Infrastructure.Operations;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>
/// DEV-13: the maintenance switch in the document store and the external effect journal beside it. The switch's newest decision
/// counts; requests trust a short cache, sends read it again and send nothing when it cannot be read; the journal refuses to
/// begin an effect while the CRM is read-only.
/// </summary>
public sealed class MaintenanceTests : IDisposable
{
    private static readonly DateTimeOffset Start = new(2026, 10, 4, 8, 0, 0, TimeSpan.Zero);
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"crm-maintenance-{Guid.NewGuid():N}");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_newest_decision_counts_and_a_change_must_name_the_decision_it_replaces()
    {
        var (gate, _, time) = Gate();
        (await gate.FreshAsync(Ct)).ShouldBe(MaintenanceState.Normal);

        var on = await gate.SetAsync(MaintenanceMode.ReadOnly, "Restore drill", "CHG-1", "Operator (1)", expectedKey: null, Ct);
        on.Key!.ShouldStartWith(DocumentStoreMaintenanceGate.Prefix);
        time.Now = time.Now.AddMinutes(1);
        var other = Gate(time: time).Gate;
        (await other.FreshAsync(Ct)).ShouldBe(on);

        // A second operator who still saw "normal", or the first one's decision, is told that another decision was taken.
        var stale = await Should.ThrowAsync<MaintenanceConflictException>(() =>
            other.SetAsync(MaintenanceMode.Normal, "Restore done", null, "Operator (2)", expectedKey: null, Ct));
        stale.Current.Key.ShouldBe(on.Key);
        var off = await other.SetAsync(MaintenanceMode.Normal, "Restore done", null, "Operator (2)", on.Key, Ct);
        (await gate.FreshAsync(Ct)).ShouldBe(off);
        await Should.ThrowAsync<MaintenanceConflictException>(() =>
            gate.SetAsync(MaintenanceMode.ReadOnly, "Again", null, "Operator (1)", on.Key, Ct));
    }

    [Fact]
    public async Task Requests_trust_the_cache_for_a_few_seconds_while_sends_always_read_the_store()
    {
        var store = new FlakyStore(new FileSystemDocumentStore(_root));
        var time = new ManualTime(Start);
        var replica = Gate(store, time).Gate;
        var operatorGate = Gate(store, time).Gate;
        (await replica.CurrentAsync(Ct)).IsReadOnly.ShouldBeFalse();

        await operatorGate.SetAsync(MaintenanceMode.ReadOnly, "Restore drill", null, "Operator (1)", null, Ct);
        time.Now = time.Now.AddSeconds(4);
        (await replica.CurrentAsync(Ct)).IsReadOnly.ShouldBeFalse("within the cache window a request may still see the old state");
        (await replica.FreshAsync(Ct)).IsReadOnly.ShouldBeTrue("a send never trusts the cache");

        // The store goes away: requests go on with the last state known, sends fail closed.
        store.Broken = true;
        time.Now = time.Now.AddSeconds(10);
        (await replica.CurrentAsync(Ct)).IsReadOnly.ShouldBeTrue();
        await Should.ThrowAsync<MaintenanceStateUnavailableException>(() => replica.FreshAsync(Ct));
        await Should.ThrowAsync<MaintenanceStateUnavailableException>(() => replica.EnsureMaySendAsync(Ct));
        await Should.ThrowAsync<MaintenanceStateUnavailableException>(() =>
            operatorGate.SetAsync(MaintenanceMode.Normal, "Restore done", null, "Operator (1)", null, Ct));
    }

    [Fact]
    public async Task A_deployment_forced_read_only_stays_read_only_whatever_the_store_says()
    {
        var (gate, _, _) = Gate(options: new MaintenanceOptions { ForceReadOnly = true, ForceReason = "Store outage" });
        var state = await gate.CurrentAsync(Ct);
        state.IsReadOnly.ShouldBeTrue();
        state.Reason.ShouldBe("Store outage");
        state.SetBy.ShouldBe("configuration");
        gate.Last.IsReadOnly.ShouldBeTrue();
        (await gate.FreshAsync(Ct)).IsReadOnly.ShouldBeTrue();
        await Should.ThrowAsync<MaintenanceConflictException>(() =>
            gate.SetAsync(MaintenanceMode.Normal, "Lift it", null, "Operator (1)", null, Ct));
        await Should.ThrowAsync<MaintenanceReadOnlyException>(() => gate.EnsureMaySendAsync(Ct));
    }

    [Fact]
    public async Task The_journal_records_an_effect_before_and_after_and_refuses_to_begin_one_during_maintenance()
    {
        var store = new FlakyStore(new FileSystemDocumentStore(_root));
        var time = new ManualTime(Start);
        var gate = Gate(store, time).Gate;
        var journal = new DocumentStoreEffectJournal(store, gate, time, NullLogger<DocumentStoreEffectJournal>.Instance);
        var basisId = Guid.NewGuid();
        var operationId = Guid.NewGuid();

        var begun = await journal.BeginAsync(new ExternalEffect("poweroffice", "sales-order", "BillingBasis", basisId, operationId), Ct);
        time.Now = time.Now.AddSeconds(2);
        await journal.CompleteAsync(begun, EffectPhase.Sent, "88001", Ct);
        var entries = await journal.ForEntityAsync("BillingBasis", basisId, Ct);
        entries.Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
        entries.ShouldAllBe(e => e.OperationId == operationId && ExternalEffects.AttemptOf(e) == begun.Id);
        ExternalEffects.LatestReference(entries).ShouldBe("88001");
        (await journal.SinceAsync(Start.AddSeconds(1), Ct)).ShouldHaveSingleItem().Phase.ShouldBe(EffectPhase.Sent);

        // Maintenance: nothing begins, nothing is written.
        await gate.SetAsync(MaintenanceMode.ReadOnly, "Restore drill", null, "Operator (1)", null, Ct);
        var other = Guid.NewGuid();
        await Should.ThrowAsync<MaintenanceReadOnlyException>(() => journal.BeginAsync(new ExternalEffect("graph", "quote-mail", "Quote", other), Ct));
        (await journal.ForEntityAsync("Quote", other, Ct)).ShouldBeEmpty();

        // An outcome is still recorded: the send it completes had left before.
        await journal.CompleteAsync(begun, EffectPhase.Failed, null, Ct);
        (await journal.ForEntityAsync("BillingBasis", basisId, Ct)).Count.ShouldBe(3);

        // A store that cannot say whether maintenance began: nothing begins either.
        store.Broken = true;
        await Should.ThrowAsync<MaintenanceStateUnavailableException>(() => journal.BeginAsync(new ExternalEffect("graph", "quote-mail", "Quote", other), Ct));
    }

    [Fact]
    public void An_effect_may_exist_when_an_attempt_was_sent_or_got_no_answer()
    {
        var at = Start;
        ExternalEffectEntry Entry(string id, EffectPhase phase, string? reference = null)
        {
            at = at.AddSeconds(1);
            return new ExternalEffectEntry(id, "poweroffice", "sales-order", "BillingBasis", Guid.Empty, null, phase, at, reference);
        }

        ExternalEffects.MayExist([]).ShouldBeFalse();
        ExternalEffects.MayExist([Entry("a", EffectPhase.Sending)]).ShouldBeTrue("no answer came back");
        ExternalEffects.MayExist([Entry("a", EffectPhase.Sending), Entry("a~Failed", EffectPhase.Failed)]).ShouldBeFalse();
        ExternalEffects.MayExist([Entry("a", EffectPhase.Sending), Entry("a~Skipped", EffectPhase.Skipped)]).ShouldBeFalse();
        ExternalEffects.MayExist([Entry("a", EffectPhase.Sending), Entry("a~Sent", EffectPhase.Sent)]).ShouldBeTrue();
        ExternalEffects.MayExist([Entry("a", EffectPhase.Sending), Entry("a~Failed", EffectPhase.Failed), Entry("b", EffectPhase.Sending)]).ShouldBeTrue();
        // An outcome whose Sending entry was not read (the restore point lies between them) still counts.
        ExternalEffects.MayExist([Entry("a~Sent", EffectPhase.Sent)]).ShouldBeTrue();
        ExternalEffects.AttemptOf(Entry("a~Sent", EffectPhase.Sent)).ShouldBe("a");
        ExternalEffects.LatestReference([Entry("a~Sent", EffectPhase.Sent, "1"), Entry("b~Sent", EffectPhase.Sent, "2"), Entry("c", EffectPhase.Sending)])
            .ShouldBe("2");
    }

    [Fact]
    public void A_scope_allows_writes_for_exactly_the_work_inside_it()
    {
        MaintenanceScope.AllowedBy.ShouldBeNull();
        using (MaintenanceScope.AllowWrites("outer"))
        {
            using (MaintenanceScope.AllowWrites("inner"))
            {
                MaintenanceScope.AllowedBy.ShouldBe("inner");
            }

            MaintenanceScope.AllowedBy.ShouldBe("outer");
        }

        MaintenanceScope.AllowedBy.ShouldBeNull();
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private (DocumentStoreMaintenanceGate Gate, IDocumentStore Store, ManualTime Time) Gate(
        IDocumentStore? store = null, ManualTime? time = null, MaintenanceOptions? options = null)
    {
        store ??= new FileSystemDocumentStore(_root);
        time ??= new ManualTime(Start);
        return (new DocumentStoreMaintenanceGate(store, new FixedOptions(options ?? new MaintenanceOptions()), time,
            NullLogger<DocumentStoreMaintenanceGate>.Instance), store, time);
    }

    private sealed class ManualTime(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class FixedOptions(MaintenanceOptions value) : IOptionsMonitor<MaintenanceOptions>
    {
        public MaintenanceOptions CurrentValue => value;

        public MaintenanceOptions Get(string? name) => value;

        public IDisposable? OnChange(Action<MaintenanceOptions, string?> listener) => null;
    }

    /// <summary>A store whose reads can be made to fail, as an outage would.</summary>
    private sealed class FlakyStore(IDocumentStore inner) : IDocumentStore
    {
        public bool Broken { get; set; }

        public Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken) =>
            Broken ? throw new IOException("unavailable") : inner.PutAsync(key, content, mediaType, cancellationToken);

        public Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken) =>
            Broken ? throw new IOException("unavailable") : inner.ReadAsync(key, cancellationToken);

        public async IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            if (Broken)
            {
                throw new IOException("unavailable");
            }

            await foreach (var item in inner.ListAsync(prefix, cancellationToken))
            {
                yield return item;
            }
        }

        public Task DeleteAsync(string key, CancellationToken cancellationToken) => inner.DeleteAsync(key, cancellationToken);
    }
}
