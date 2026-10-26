using Crm.Authorization;
using Crm.Integrations.Core.Readiness;
using static Crm.UnitTests.ConnectionStatusTestSupport;

namespace Crm.UnitTests;

/// <summary>M38: the connections page is green only for a complete picture of the CRM's own integration state.</summary>
public sealed class ConnectionStatusReaderTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Only_integration_managers_read_the_view_and_nothing_is_read_before_that_check(bool admin, bool customers)
    {
        var permissions = new List<string>();
        if (admin) permissions.Add(Permissions.IntegrationsManage);
        if (customers) permissions.Add(Permissions.CustomersRead);
        var stored = new Stored(); var catalog = new TestCatalog();
        var result = await Reader(new User(Employee, permissions.ToArray()), stored, catalog).ReadAsync(default);
        result.IsSuccess.ShouldBe(admin);
        if (!admin) result.Error!.Code.ShouldBe("CONNECTION_STATUS_FORBIDDEN");
        stored.Calls.ShouldBe(admin ? 1 : 0); catalog.Calls.ShouldBe(admin ? 1 : 0);
        (await Reader(new User(null, Permissions.IntegrationsManage)).ReadAsync(default)).IsSuccess.ShouldBeFalse();
    }

    [Fact]
    public async Task Fresh_jobs_and_a_beating_worker_are_ready_with_every_job_in_the_order_the_catalog_names_them()
    {
        var view = (await Reader(new(Employee, Permissions.IntegrationsManage)).ReadAsync(default)).Value;

        view.Status.ShouldBe("Ready");
        view.Gaps.ShouldBeEmpty();
        view.CheckedAt.ShouldBe(Now);
        view.Integrations.Select(i => i.System).ShouldBe(["atera", "brreg"]);
        var atera = view.Integrations[0];
        (atera.Enabled, atera.WriteEnabled, atera.State!.Paused, atera.State.FailedOutbound).ShouldBe((true, (bool?)true, false, 0));
        atera.State.Jobs.Select(j => (j.Job, j.Freshness, j.AgeMinutes)).ShouldBe([("atera-alerts", "Fresh", (int?)5), ("atera-tickets", "Fresh", 3)]);
        view.Integrations[1].WriteEnabled.ShouldBeNull();
        view.Worker!.StaleAfterSeconds.ShouldBe(180);
        view.Worker.Components.Select(c => (c.Component, c.State, c.AgeSeconds))
            .ShouldBe([("outbox", "Current", (int?)20), ("jobs", "Current", 40), ("actions", "Current", 10), ("early-reads", "Current", 5)]);
    }

    [Fact]
    public void Every_gap_is_named_once_with_its_job_or_part()
    {
        var state = State(
        [
            // Fresh, but the run after the last success failed: the next read may not come.
            Stream("atera", "atera-alerts", Minutes(5), failed: Minutes(1)),
            Stream("atera", "atera-tickets", Minutes(95), failedOutbound: 2),
            Stream("brreg", "brreg-registry-check", null),
        ], Beat("jobs", 900), Beat("actions", 5));

        var view = ConnectionStatusReader.Compose([Atera, Brreg], state, Now);

        view.Status.ShouldBe("Gaps");
        view.Gaps.ShouldBe(
        [
            new ConnectionGap("Failed", "atera", "atera-alerts"), new ConnectionGap("Stale", "atera", "atera-tickets"),
            new ConnectionGap("OutboundFailed", "atera", Count: 2), new ConnectionGap("Never", "brreg", "brreg-registry-check"),
            new ConnectionGap("WorkerMissing", Component: "outbox"), new ConnectionGap("WorkerLate", Component: "jobs"),
            new ConnectionGap("WorkerMissing", Component: "early-reads"),
        ]);
        view.Integrations[0].State!.Jobs[0].LastFailedAt.ShouldBe(Minutes(1));
        view.Worker!.Components.Select(c => (c.State, c.BeatAt))
            .ShouldBe([("Missing", (DateTimeOffset?)null), ("Late", Now.AddSeconds(-900)), ("Current", Now.AddSeconds(-5)), ("Missing", null)]);
    }

    [Fact]
    public void A_failure_that_a_success_followed_is_reported_but_is_no_gap()
    {
        var state = State([Stream("atera", "atera-alerts", Minutes(2), failed: Minutes(30)), Stream("atera", "atera-tickets", Minutes(3))],
            Beat("outbox", 5), Beat("jobs", 5), Beat("actions", 5), Beat("early-reads", 5));

        var view = ConnectionStatusReader.Compose([Atera], state, Now);

        view.Status.ShouldBe("Ready");
        view.Integrations[0].State!.Jobs[0].LastFailedAt.ShouldBe(Minutes(30));
    }

    [Fact]
    public void An_action_without_a_clear_answer_keeps_the_page_from_green_until_someone_checks_it()
    {
        var state = State([Stream("atera", "atera-alerts", Minutes(2)), Stream("atera", "atera-tickets", Minutes(3))],
            Beat("outbox", 5), Beat("jobs", 5), Beat("actions", 5), Beat("early-reads", 5)) with { UncertainActions = new Dictionary<string, int> { ["atera"] = 2 } };

        var view = ConnectionStatusReader.Compose([Atera], state, Now);

        view.Status.ShouldBe("Gaps");
        view.Gaps.ShouldBe([new ConnectionGap("ActionsUncertain", "atera", Count: 2)]);
        ConnectionStatusReader.Compose([Atera], state with { UncertainActions = new Dictionary<string, int>() }, Now).Status.ShouldBe("Ready");
    }

    [Fact]
    public void A_pause_is_one_gap_for_the_integration_and_a_switched_off_integration_none()
    {
        var office = new ConnectionDefinition("poweroffice", false, false, ["poweroffice-customers"]);
        var state = State(
        [
            Stream("atera", "atera-alerts", Minutes(400), paused: true), Stream("atera", "atera-tickets", null, paused: true),
            Stream("poweroffice", "poweroffice-customers", null),
        ], Beat("outbox", 5), Beat("jobs", 5), Beat("actions", 5), Beat("early-reads", 5));

        var view = ConnectionStatusReader.Compose([Atera, office], state, Now);

        view.Gaps.ShouldBe([new ConnectionGap("Paused", "atera")]);
        view.Integrations[0].State!.Paused.ShouldBeTrue();
        // Off for good: its jobs are not expected to run, so "never read" is not a gap there.
        view.Integrations[1].State!.Jobs.Single().Freshness.ShouldBe("Disabled");
        view.Integrations[1].Enabled.ShouldBeFalse();
    }

    [Fact]
    public void A_webhook_is_described_for_the_systems_that_have_one_and_a_refused_delivery_is_no_gap()
    {
        var atera = Atera with { WebhookEnabled = true };
        var state = State([Stream("atera", "atera-alerts", Minutes(2)), Stream("atera", "atera-tickets", Minutes(3)), Stream("brreg", "brreg-registry-check", Minutes(10))],
            Beat("outbox", 5), Beat("jobs", 5), Beat("actions", 5), Beat("early-reads", 5)) with
        {
            Webhooks = new Dictionary<string, StoredWebhook>
            {
                ["atera"] = new(Minutes(4), "ticket", 7, Minutes(1), "BadSignature", Minutes(4)),
            },
        };

        var view = ConnectionStatusReader.Compose([atera, Brreg], state, Now);

        // The scheduled reads go on: only sooner reads stop, so the page stays green and the card names the refusal.
        view.Status.ShouldBe("Ready");
        view.Integrations[0].Webhook.ShouldBe(new ConnectionWebhook(true, Minutes(4), "ticket", 7, Minutes(1), "BadSignature", Minutes(4)));
        view.Integrations[1].Webhook.ShouldBeNull();
        // A webhook switched off is described as off, with whatever it did before.
        ConnectionStatusReader.Compose([atera with { WebhookEnabled = false }], state, Now).Integrations[0].Webhook!.Enabled.ShouldBeFalse();
        // Nothing heard yet: no facts, no zeroes but the count.
        ConnectionStatusReader.Compose([atera], state with { Webhooks = null }, Now).Integrations[0].Webhook
            .ShouldBe(new ConnectionWebhook(true, null, null, 0, null, null, null));
        ConnectionStatusReader.Compose([atera], null, Now).Integrations[0].Webhook.ShouldBeNull();
    }

    [Fact]
    public void The_worker_is_alive_while_any_of_its_instances_beats()
    {
        // A replaced container leaves its old row behind for a week; the new instance's beat is what counts.
        var state = State([Stream("brreg", "brreg-registry-check", Minutes(10))],
            Beat("outbox", 5000, "worker-old"), Beat("outbox", 10, "worker-new"), Beat("jobs", 5000, "worker-old"), Beat("jobs", 30, "worker-new"),
            Beat("actions", 5000, "worker-old"), Beat("actions", 20, "worker-new"), Beat("early-reads", 5000, "worker-old"), Beat("early-reads", 15, "worker-new"));

        var view = ConnectionStatusReader.Compose([Brreg], state, Now);

        view.Status.ShouldBe("Ready");
        view.Worker!.Components.Select(c => c.AgeSeconds).ShouldBe([10, 30, 20, 15]);
    }

    [Fact]
    public async Task Whole_operation_deadline_returns_unavailable_switches_and_never_zeroes_or_old_evidence()
    {
        var clock = new StatusClock(); var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stored = new Stored { Reply = async ct => { entered.SetResult(); await Task.Delay(Timeout.InfiniteTimeSpan, ct); throw new InvalidOperationException(); } };
        var pending = Reader(new(Employee, Permissions.IntegrationsManage), stored, time: clock).ReadAsync(default);
        await entered.Task; clock.Advance(ConnectionStatusReader.Budget); var view = (await pending).Value;

        view.Status.ShouldBe("Unavailable");
        view.Worker.ShouldBeNull();
        view.Gaps.ShouldBeEmpty();
        view.Integrations.Select(i => (i.System, i.Enabled, i.State)).ShouldBe([("atera", true, (ConnectionIntegrationState?)null), ("brreg", true, null)]);
    }

    [Fact]
    public async Task A_database_that_cannot_be_read_is_unavailable()
    {
        var stored = new Stored { Reply = _ => throw new SyntheticDbException() };
        var view = (await Reader(new(Employee, Permissions.IntegrationsManage), stored).ReadAsync(default)).Value;
        view.Status.ShouldBe("Unavailable");
        view.Integrations.ShouldAllBe(i => i.State == null);
    }

    [Fact]
    public async Task Caller_cancellation_is_preserved()
    {
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(() => Reader(new(Employee, Permissions.IntegrationsManage)).ReadAsync(canceled.Token));
    }
}
