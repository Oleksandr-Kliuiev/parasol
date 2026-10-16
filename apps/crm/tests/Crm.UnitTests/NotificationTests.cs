using Crm.Identity.Contracts;
using Crm.Notifications;
using Crm.Notifications.Contracts;
using Crm.Notifications.Domain;
using Crm.Notifications.Features;

namespace Crm.UnitTests;

public class NotificationTests
{
    private static NotificationRequest Request(
        NotificationKind kind = NotificationKind.ContractEnding, string key = "reminder:1", bool warning = false) => new(
        kind,
        Guid.NewGuid(),
        key,
        new Dictionary<string, string> { ["number"] = "K-2026-0007", ["organization"] = "Havbris AS", ["date"] = "31.12.2026", ["days"] = "30" },
        Guid.NewGuid(),
        "/contracts/1",
        new DateOnly(2026, 12, 31),
        warning);

    [Fact]
    public void A_notification_keeps_its_parameters_instead_of_a_finished_sentence()
    {
        var notification = Notification.Create(Request());

        notification.Parameters["number"].ShouldBe("K-2026-0007");
        notification.IsUnread.ShouldBeTrue();
        notification.EmailStatus.ShouldBe(EmailStatus.Pending);
    }

    [Fact]
    public void Reading_a_notification_twice_keeps_the_first_time()
    {
        var notification = Notification.Create(Request());
        var first = DateTimeOffset.Parse("2026-09-16T08:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        notification.MarkRead(first);
        notification.MarkRead(first.AddHours(1));

        notification.ReadAt.ShouldBe(first);
        notification.IsUnread.ShouldBeFalse();
    }

    [Fact]
    public void A_muted_kind_is_never_e_mailed_but_stays_in_the_crm()
    {
        var notification = Notification.Create(Request());

        notification.SuppressEmail("The reader muted this kind.");

        notification.EmailStatus.ShouldBe(EmailStatus.Suppressed);
        notification.IsUnread.ShouldBeTrue();
    }

    [Fact]
    public void Preferences_clamp_the_digest_hour_and_remember_muted_kinds()
    {
        var preference = NotificationPreference.Default(Guid.NewGuid());
        preference.DigestHour.ShouldBe(7);
        preference.EmailEnabled.ShouldBeTrue();

        preference.Update(emailEnabled: false, digestHour: 42, [NotificationKind.StaleOpportunity, NotificationKind.StaleOpportunity]);

        preference.DigestHour.ShouldBe(23);
        preference.EmailEnabled.ShouldBeFalse();
        preference.MutedKinds.ShouldBe([NotificationKind.StaleOpportunity]);
        preference.IsMuted(NotificationKind.StaleOpportunity).ShouldBeTrue();
        preference.IsMuted(NotificationKind.ContractEnding).ShouldBeFalse();
    }

    [Theory]
    [InlineData("nb", "utløper")]
    [InlineData("en", "ends")]
    public void The_digest_speaks_the_readers_language(string language, string expected)
    {
        var line = NotificationTexts.Line(
            NotificationKind.ContractEnding,
            new Dictionary<string, string> { ["number"] = "K-2026-0007", ["organization"] = "Havbris AS", ["date"] = "31.12.2026", ["days"] = "30" },
            language);

        line.ShouldContain(expected);
        line.ShouldContain("K-2026-0007");
    }

    [Fact]
    public void A_missing_parameter_becomes_a_dash_instead_of_an_empty_sentence()
    {
        NotificationTexts.Line(NotificationKind.InvoiceOverdue, new Dictionary<string, string>(), "en").ShouldContain("—");
    }

    [Fact]
    public void The_digest_lists_every_notice_with_a_link_and_counts_the_rest()
    {
        var profile = new UserProfile(Guid.NewGuid(), "Kari Nordmann", "kari@vardahei.no", "en", true);
        var settings = new NotificationsOptions { AppBaseUrl = "https://crm.vardahei.no/", MaxItemsPerEmail = 2 };
        var items = new[]
        {
            Notification.Create(Request(key: "a")),
            Notification.Create(Request(NotificationKind.InvoiceOverdue, "b", warning: true)),
            Notification.Create(Request(NotificationKind.StaleOpportunity, "c")),
        };

        var email = NotificationDigestJob.Compose(profile, items, settings);

        email.ToAddress.ShouldBe("kari@vardahei.no");
        email.Subject.ShouldBe("Vardahei CRM: 3 items need attention");
        email.HtmlBody.ShouldContain("https://crm.vardahei.no/contracts/1");
        email.HtmlBody.ShouldContain("and 1 more");
        email.TextBody.ShouldContain("Hi Kari Nordmann");
        email.TextBody.ShouldContain("turn this e-mail off");
    }

    [Fact]
    public void The_digest_shows_an_overdue_amount_only_to_a_recipient_who_may_see_money()
    {
        // DEV-12-AC04: the notice keeps its parameters; the digest leaves the amount out for a reader without finance.read.
        var notification = Notification.Create(new NotificationRequest(
            NotificationKind.InvoiceOverdue,
            Guid.NewGuid(),
            "overdue",
            new Dictionary<string, string> { ["number"] = "10042", ["organization"] = "Havbris", ["date"] = "01.09.2026", ["amount"] = "12 500 NOK", ["days"] = "33" }));

        var technician = new UserProfile(Guid.NewGuid(), "Ola", "ola@vardahei.no", "en", true, [Crm.Authorization.CrmRoles.Technician]);
        var finance = new UserProfile(Guid.NewGuid(), "Kari", "kari@vardahei.no", "en", true, [Crm.Authorization.CrmRoles.Finance]);

        var withoutMoney = NotificationDigestJob.Compose(technician, [notification], new NotificationsOptions());
        withoutMoney.TextBody.ShouldNotContain("12 500");
        withoutMoney.TextBody.ShouldContain("Invoice 10042 to Havbris was due 01.09.2026 and is unpaid.");
        NotificationDigestJob.Compose(finance, [notification], new NotificationsOptions()).TextBody.ShouldContain("12 500 NOK outstanding");
    }

    [Fact]
    public void The_digest_escapes_what_users_typed()
    {
        var profile = new UserProfile(Guid.NewGuid(), "Kari", "kari@vardahei.no", "en", true);
        var notification = Notification.Create(new NotificationRequest(
            NotificationKind.StaleOpportunity,
            Guid.NewGuid(),
            "xss",
            new Dictionary<string, string> { ["name"] = "<script>alert(1)</script>", ["organization"] = "Havbris", ["days"] = "45" }));

        var email = NotificationDigestJob.Compose(profile, [notification], new NotificationsOptions());

        email.HtmlBody.ShouldNotContain("<script>");
        email.HtmlBody.ShouldContain("&lt;script&gt;");
    }
}
