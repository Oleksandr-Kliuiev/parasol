using System.Net;
using System.Text.Json;
using Crm.Integrations.Atera;
using Crm.Integrations.Core;
using Crm.Integrations.PartnerCenter;

namespace Crm.UnitTests;

/// <summary>Atera and Partner Center resilience (DEV-19): update payloads, retry rules, markers and schedule-aware freshness.</summary>
public class AteraResilienceUnitTests
{
    private static AteraCustomer Current(string? businessNumber = "NO 923609016 MVA", string? phone = "+47 77 00 00 00", string? city = "Tromsø") =>
        new(17, "Nordlys Drift AS", businessNumber, "nordlys.no", "Kirkegata 5", city, "9008", "Norway", phone, "https://nordlys.no", null);

    private static AteraCustomerWrite Desired(string? phone = "+47 77 00 00 00", string? city = "Tromsø", string name = "Nordlys Drift AS", string? orgNumber = "923609016") =>
        new(name, orgNumber, "nordlys.no", "Kirkegata 5", city, "9008", "Norway", phone, "https://nordlys.no");

    [Fact]
    public void Nothing_is_sent_when_no_crm_owned_field_differs()
    {
        // The business number is free text in Atera; the same nine digits are not a change.
        AteraMapping.MergeForUpdate(Current(), Desired()).ShouldBeNull();
    }

    [Fact]
    public void A_field_the_crm_has_no_value_for_keeps_the_value_atera_has()
    {
        var update = AteraMapping.MergeForUpdate(Current(), Desired(phone: null, city: "Bodø")).ShouldNotBeNull();

        update.City.ShouldBe("Bodø");
        update.Phone.ShouldBe("+47 77 00 00 00");
        update.Website.ShouldBe("https://nordlys.no");
        update.BusinessNumber.ShouldBe("NO 923609016 MVA");
    }

    [Fact]
    public void Only_empty_crm_fields_never_produce_a_put()
    {
        AteraMapping.MergeForUpdate(Current(), new AteraCustomerWrite("Nordlys Drift AS", null, null, null, null, null, null, null, null)).ShouldBeNull();
    }

    [Fact]
    public void A_renamed_organization_is_sent()
    {
        AteraMapping.MergeForUpdate(Current(), Desired(name: "Nordlys AS"))!.CustomerName.ShouldBe("Nordlys AS");
    }

    [Theory]
    [InlineData("POST", 429, true)]
    [InlineData("PUT", 429, true)]
    [InlineData("POST", 503, false)]
    [InlineData("POST", 500, false)]
    [InlineData("GET", 503, true)]
    [InlineData("GET", 404, false)]
    public void Throttling_is_repeated_for_any_method_and_server_errors_only_for_reads(string method, int status, bool retried) =>
        AteraModule.ShouldRetry(new HttpMethod(method), (HttpStatusCode)status, null).ShouldBe(retried);

    [Fact]
    public void A_dropped_connection_repeats_a_read_but_never_a_write()
    {
        AteraModule.ShouldRetry(HttpMethod.Get, null, new HttpRequestException()).ShouldBeTrue();
        AteraModule.ShouldRetry(HttpMethod.Post, null, new HttpRequestException()).ShouldBeFalse();
        AteraModule.ShouldRetry(HttpMethod.Post, null, new TimeoutException()).ShouldBeFalse();
    }

    [Fact]
    public void The_marker_identifies_the_request_inside_the_description()
    {
        var id = Guid.Parse("11111111-2222-3333-4444-555555555555");

        AteraTicketMarker.Of(id).ShouldBe("[CRM-TR:11111111-2222-3333-4444-555555555555]");
        AteraTicketMarker.Embed("Printer is down", id).ShouldBe("Printer is down\n\n[CRM-TR:11111111-2222-3333-4444-555555555555]");
        AteraTicketMarker.Embed("  ", id).ShouldBe("[CRM-TR:11111111-2222-3333-4444-555555555555]");
    }

    [Fact]
    public void A_ticket_description_is_read()
    {
        using var doc = JsonDocument.Parse("""{"TicketID": 9, "TicketTitle": "x", "TicketDescription": "Hello [CRM-TR:abc]", "TicketCreatedDate": "2026-09-15T08:00:00Z"}""");

        AteraClient.ReadTicket(doc.RootElement)!.Description.ShouldBe("Hello [CRM-TR:abc]");
    }

    [Theory]
    [InlineData("""{"WorkHoursID": "1", "TimeSpentInMinutes": 90}""", true)]
    [InlineData("""{"WorkHoursID": "1", "TimeSpentInMinutes": 0}""", false)]
    [InlineData("""{"WorkHoursID": "1"}""", false)]
    [InlineData("""{"TimeSpentInMinutes": 30}""", false)]
    public void Work_hour_rows_without_an_id_or_a_duration_are_not_usable(string json, bool usable)
    {
        using var doc = JsonDocument.Parse(json);

        (AteraClient.ReadWorkHours(doc.RootElement, 5) is not null).ShouldBe(usable);
    }
}

public class CronCadenceTests
{
    [Theory]
    [InlineData("*/30 * * * *", 30)]
    [InlineData("5-59/10 * * * *", 10)]
    [InlineData("30 1 * * *", 1440)]
    [InlineData("0 6,18 * * *", 720)]
    [InlineData("0 9 * * *", 1440)]
    public void The_longest_gap_between_runs_is_read_from_the_schedule(string cron, int expected) =>
        CronCadence.LongestGapMinutes(cron).ShouldBe(expected);

    [Theory]
    [InlineData("0 9 * * 1")]
    [InlineData("0 9 1 * *")]
    [InlineData("not a cron")]
    [InlineData("61 * * * *")]
    public void Schedules_that_restrict_days_or_cannot_be_read_have_no_gap(string cron) =>
        CronCadence.LongestGapMinutes(cron).ShouldBeNull();

    [Fact]
    public void A_job_is_overdue_after_one_and_a_half_gaps_and_a_quarter_of_an_hour()
    {
        CronCadence.FreshnessMinutes("*/30 * * * *", "unused").ShouldBe(60);
        CronCadence.FreshnessMinutes("50 2 * * *", "unused").ShouldBe(2175);
        CronCadence.FreshnessMinutes(null, "*/30 * * * *").ShouldBe(60);
        CronCadence.FreshnessMinutes("0 9 * * 1", "*/30 * * * *").ShouldBeNull();
    }
}

public class PartnerCenterResilienceUnitTests
{
    [Theory]
    [InlineData("GET", 429, true)]
    [InlineData("POST", 429, true)]
    [InlineData("GET", 503, true)]
    [InlineData("GET", 408, true)]
    [InlineData("POST", 503, false)]
    [InlineData("GET", 403, false)]
    public void Throttling_is_repeated_and_transient_failures_only_for_reads(string method, int status, bool retried) =>
        PartnerCenterModule.ShouldRetry(new HttpMethod(method), (HttpStatusCode)status, null).ShouldBe(retried);

    [Fact]
    public void A_limited_reading_is_not_an_empty_tenant()
    {
        var limited = PcSkuReading.Limited("no access (403)");

        limited.Limitation.ShouldBe("no access (403)");
        limited.Skus.ShouldBeEmpty();
        new PcSkuReading([]).Limitation.ShouldBeNull();
    }
}

public class PollyTimeoutRetryTests
{
    [Fact]
    public void A_read_that_hit_the_attempt_timeout_is_repeated_but_a_write_is_not()
    {
        // Polly's timeout rejection is not a TimeoutException; it must be named, or a slow read is never repeated.
        var timeout = new Polly.Timeout.TimeoutRejectedException("slow");

        AteraModule.ShouldRetry(HttpMethod.Get, null, timeout).ShouldBeTrue();
        PartnerCenterModule.ShouldRetry(HttpMethod.Get, null, timeout).ShouldBeTrue();
        AteraModule.ShouldRetry(HttpMethod.Post, null, timeout).ShouldBeFalse();
        PartnerCenterModule.ShouldRetry(HttpMethod.Post, null, timeout).ShouldBeFalse();
        Crm.Integrations.PowerOffice.PowerOfficeModule.ShouldRetry(HttpMethod.Get, null, timeout).ShouldBeTrue();
        Crm.Integrations.PowerOffice.PowerOfficeModule.ShouldRetry(HttpMethod.Post, null, timeout).ShouldBeFalse();
    }
}
