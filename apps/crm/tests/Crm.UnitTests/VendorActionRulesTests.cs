using System.Text.Json;
using Crm.Integrations.Core.Actions;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.UnitTests;

/// <summary>M39.1: the rules every vendor action follows — switches, confirmation, the signed preview and the retry pauses.</summary>
public class VendorActionRulesTests
{
    private static VendorActionSwitches Switches(
        bool enabled = true, bool configured = true, bool write = true, bool dryRun = false, string[]? allowed = null, string[]? kinds = null) =>
        new(enabled, configured, write, dryRun, allowed ?? [], kinds ?? ["ticket.reply"]);

    private static VendorAction Action(string targetType, string targetId, string parameters) => new()
    {
        System = "atera", Kind = "k", TargetType = targetType, TargetId = targetId, TargetName = "n", Parameters = parameters, Fingerprint = "f",
    };

    [Theory]
    [InlineData("ticket", "4711", "{}", 4711L)]
    [InlineData("ticket", "not-a-number", "{}", null)]
    [InlineData("time-entry", "5f0c9a1e-0000-0000-0000-000000000001", "{\"ticket\":4711,\"billable\":true}", 4711L)]
    [InlineData("time-entry", "5f0c9a1e-0000-0000-0000-000000000001", "{}", null)]
    [InlineData("time-entry", "5f0c9a1e-0000-0000-0000-000000000001", "{\"ticket\":\"4711\"}", null)]
    [InlineData("device", "d-1", "not json", null)]
    public void An_action_names_the_ticket_it_concerns_by_its_target_or_its_ticket_parameter(string targetType, string targetId, string parameters, long? ticket) =>
        VendorActionTargets.TicketOf(Action(targetType, targetId, parameters)).ShouldBe(ticket);

    [Fact]
    public void Switches_that_allow_the_kind_for_the_customer_block_nothing() =>
        VendorActionRules.CheckSwitches(Switches(), "ticket.reply", "17", credentials: true).ShouldBeNull();

    [Theory]
    [InlineData(false, true, true, false, null, "ticket.reply", "VND_INTEGRATION_OFF")]
    [InlineData(true, false, true, false, null, "ticket.reply", "VND_INTEGRATION_NOT_CONFIGURED")]
    [InlineData(true, true, true, false, null, "ticket.close", "VND_KIND_DISABLED")]
    [InlineData(true, true, false, false, null, "ticket.reply", "VND_WRITE_DISABLED")]
    [InlineData(true, true, true, false, "99", "ticket.reply", "VND_CUSTOMER_NOT_ALLOWED")]
    public void Each_switch_blocks_with_its_own_code(bool enabled, bool configured, bool write, bool dryRun, string? allowed, string kind, string code) =>
        VendorActionRules.CheckSwitches(Switches(enabled, configured, write, dryRun, allowed is null ? null : [allowed]), kind, "17", credentials: true)!
            .Code.ShouldBe(code);

    [Fact]
    public void DryRun_allows_an_action_with_writing_off_because_nothing_is_sent() =>
        VendorActionRules.CheckSwitches(Switches(write: false, dryRun: true), "ticket.reply", "17", credentials: true).ShouldBeNull();

    [Fact]
    public void Crm_web_leaves_the_credentials_to_the_worker_and_an_unknown_vendor_is_off()
    {
        VendorActionRules.CheckSwitches(Switches(configured: false), "ticket.reply", "17", credentials: false).ShouldBeNull();
        VendorActionRules.CheckSwitches(null, "ticket.reply", "17", credentials: false)!.Code.ShouldBe("VND_INTEGRATION_OFF");
    }

    [Fact]
    public void An_allow_list_refuses_a_target_without_a_customer() =>
        VendorActionRules.CheckSwitches(Switches(allowed: ["17"]), "ticket.reply", null, credentials: false)!.Code.ShouldBe("VND_CUSTOMER_NOT_ALLOWED");

    [Theory]
    [InlineData(VendorActionLevel.Standard, null, null, null)]
    [InlineData(VendorActionLevel.Disruptive, null, null, "VND_REASON_REQUIRED")]
    [InlineData(VendorActionLevel.Disruptive, "too short", null, "VND_REASON_REQUIRED")]
    [InlineData(VendorActionLevel.Disruptive, "The customer asked us to pause", null, null)]
    [InlineData(VendorActionLevel.Destructive, "The customer asked us to remove it", "PC-11", "VND_NAME_MISMATCH")]
    [InlineData(VendorActionLevel.Destructive, "The customer asked us to remove it", "  srv  -12 ", "VND_NAME_MISMATCH")]
    [InlineData(VendorActionLevel.Destructive, "The customer asked us to remove it", "  srv-12 ", null)]
    [InlineData(VendorActionLevel.Destructive, null, "SRV-12", "VND_REASON_REQUIRED")]
    public void A_level_asks_for_its_confirmation(VendorActionLevel level, string? reason, string? typed, string? code) =>
        (VendorActionRules.CheckConfirmation(level, reason, typed, "SRV-12")?.Code).ShouldBe(code);

    [Fact]
    public void A_typed_name_ignores_case_and_runs_of_spaces_between_words() =>
        VendorActionRules.NameMatches(" nordlys   drift as ", "Nordlys Drift AS").ShouldBeTrue();

    [Fact]
    public void Canonical_parameters_do_not_depend_on_order_or_spacing()
    {
        var one = JsonDocument.Parse("""{ "text" : "Hei", "nested": {"b": 2, "a": [3, 1]}, "flag": true }""").RootElement;
        var two = JsonDocument.Parse("""{"flag":true,"nested":{"a":[3,1],"b":2},"text":"Hei"}""").RootElement;

        VendorActionRules.Canonical(one).ShouldBe(VendorActionRules.Canonical(two));
        VendorActionRules.Canonical(one).ShouldBe("""{"flag":true,"nested":{"a":[3,1],"b":2},"text":"Hei"}""");
        VendorActionRules.Canonical(new Dictionary<string, object?> { ["text"] = "Hei", ["flag"] = true })
            .ShouldBe("""{"flag":true,"text":"Hei"}""");
    }

    [Fact]
    public void The_fingerprint_changes_with_every_part_of_the_action()
    {
        var baseline = VendorActionRules.Fingerprint("atera", "ticket.reply", "ticket", "17", """{"text":"Hei"}""");
        baseline.Length.ShouldBe(64);
        VendorActionRules.Fingerprint("atera", "ticket.note", "ticket", "17", """{"text":"Hei"}""").ShouldNotBe(baseline);
        VendorActionRules.Fingerprint("atera", "ticket.reply", "ticket", "18", """{"text":"Hei"}""").ShouldNotBe(baseline);
        VendorActionRules.Fingerprint("atera", "ticket.reply", "ticket", "17", """{"text":"Hei!"}""").ShouldNotBe(baseline);
        VendorActionRules.Fingerprint("atera", "ticket.reply", "ticket", "17", """{"text":"Hei"}""").ShouldBe(baseline);
    }

    [Fact]
    public void A_preview_token_reads_back_only_unchanged_and_only_for_its_purpose()
    {
        var protection = new EphemeralDataProtectionProvider();
        var claim = new VendorActionPreviewClaim(Guid.NewGuid(), new string('a', 64), VendorActionLevel.Destructive, DateTimeOffset.UnixEpoch.AddDays(1));
        var token = VendorActionPreviewToken.Issue(protection, claim);

        VendorActionPreviewToken.Read(protection, token).ShouldBe(claim);
        VendorActionPreviewToken.Read(protection, token[..^2] + (token[^2] == 'A' ? "BA" : "AA")).ShouldBeNull();
        VendorActionPreviewToken.Read(protection, protection.CreateProtector("another purpose").Protect("""{"UserId":"00000000-0000-0000-0000-000000000000"}""")).ShouldBeNull();
        VendorActionPreviewToken.Read(new EphemeralDataProtectionProvider(), token).ShouldBeNull();
        VendorActionPreviewToken.Read(protection, "not a token").ShouldBeNull();
        VendorActionPreviewToken.Read(protection, null).ShouldBeNull();
    }

    [Fact]
    public void Attempts_without_an_answer_wait_longer_each_time_up_to_a_quarter_hour()
    {
        var pauses = Enumerable.Range(1, VendorActionRules.MaxAttempts + 2).Select(VendorActionRules.Backoff).ToList();
        pauses.ShouldBe(pauses.Order().ToList());
        pauses[0].ShouldBe(TimeSpan.FromSeconds(15));
        pauses[^1].ShouldBe(TimeSpan.FromMinutes(15));
    }

    [Fact]
    public void Each_level_names_what_confirming_takes()
    {
        VendorActionConfirmation.For(VendorActionLevel.Standard).ShouldBe(new VendorActionConfirmation(false, false, false, 0));
        VendorActionConfirmation.For(VendorActionLevel.Disruptive).ShouldBe(new VendorActionConfirmation(true, false, false, 0));
        VendorActionConfirmation.For(VendorActionLevel.Destructive).ShouldBe(new VendorActionConfirmation(true, true, true, 60));
    }
}
