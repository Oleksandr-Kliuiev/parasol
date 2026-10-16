using System.Globalization;
using Crm.Notifications.Contracts;

namespace Crm.Notifications.Features;

/// <summary>
/// The wording of the digest e-mail. The interface renders the same notices through i18n; e-mail leaves the browser behind,
/// so the two languages of the company (bokmål, English) live here, keyed by kind.
/// </summary>
internal static class NotificationTexts
{
    public static bool IsNorwegian(string? language) =>
        language is null || language.StartsWith("nb", StringComparison.OrdinalIgnoreCase) || language.StartsWith("no", StringComparison.OrdinalIgnoreCase);

    public static string Subject(string? language, int count) => IsNorwegian(language)
        ? count == 1 ? "Vardahei CRM: 1 sak venter" : $"Vardahei CRM: {count} saker venter"
        : count == 1 ? "Vardahei CRM: 1 item needs attention" : $"Vardahei CRM: {count} items need attention";

    public static string Greeting(string? language, string name) => IsNorwegian(language)
        ? $"Hei {name}, dette venter på deg i CRM:"
        : $"Hi {name}, this is waiting for you in the CRM:";

    public static string More(string? language, int count) => IsNorwegian(language)
        ? $"… og {count} flere i CRM."
        : $"… and {count} more in the CRM.";

    public static string Footer(string? language) => IsNorwegian(language)
        ? "Du kan slå av denne e-posten under Varsler i CRM."
        : "You can turn this e-mail off under Notifications in the CRM.";

    /// <summary>One line per notice, built from the parameters the sender stored.</summary>
    public static string Line(NotificationKind kind, IReadOnlyDictionary<string, string> p, string? language)
    {
        var nb = IsNorwegian(language);
        string Value(string key) => p.GetValueOrDefault(key, "—");

        return kind switch
        {
            NotificationKind.ContractEnding => nb
                ? $"Avtale {Value("number")} for {Value("organization")} utløper {Value("date")} (om {Value("days")} dager)."
                : $"Contract {Value("number")} for {Value("organization")} ends {Value("date")} (in {Value("days")} days).",
            NotificationKind.NoticeDeadline => nb
                ? $"Avtale {Value("number")} for {Value("organization")}: siste dag å si opp er {Value("date")}."
                : $"Contract {Value("number")} for {Value("organization")}: the last day to give notice is {Value("date")}.",
            NotificationKind.HourBankLow => nb
                ? $"Timepakken «{Value("name")}» hos {Value("organization")} har {Value("hours")} timer igjen."
                : $"The prepaid package “{Value("name")}” at {Value("organization")} has {Value("hours")} hours left.",
            NotificationKind.SubscriptionCancellationWindow => nb
                ? $"{Value("offer")} hos {Value("organization")}: angrefristen går ut {Value("date")}."
                : $"{Value("offer")} at {Value("organization")}: the cancellation window closes {Value("date")}.",
            NotificationKind.SubscriptionRenewal => nb
                ? $"{Value("offer")} hos {Value("organization")} fornyes {Value("date")} ({Value("quantity")} lisenser)."
                : $"{Value("offer")} at {Value("organization")} renews {Value("date")} ({Value("quantity")} licences).",
            NotificationKind.StaleOpportunity => nb
                ? $"Salget «{Value("name")}» hos {Value("organization")} har ikke hatt aktivitet i {Value("days")} dager."
                : $"The deal “{Value("name")}” at {Value("organization")} has had no activity for {Value("days")} days.",
            NotificationKind.InvoiceOverdue when !p.ContainsKey("amount") => nb
                ? $"Faktura {Value("number")} til {Value("organization")} forfalt {Value("date")} og er ikke betalt."
                : $"Invoice {Value("number")} to {Value("organization")} was due {Value("date")} and is unpaid.",
            NotificationKind.InvoiceOverdue => nb
                ? $"Faktura {Value("number")} til {Value("organization")} forfalt {Value("date")}: {Value("amount")} utestående."
                : $"Invoice {Value("number")} to {Value("organization")} was due {Value("date")}: {Value("amount")} outstanding.",
            _ => nb ? "Noe venter på deg i CRM." : "Something is waiting for you in the CRM.",
        };
    }

    public static string Money(decimal amount) => amount.ToString("N0", CultureInfo.GetCultureInfo("nb-NO")) + " NOK";

    /// <summary>Parameters that carry money: shown only to readers with finance.read (DEV-12-AC04), in the app and in the digest.</summary>
    public static readonly IReadOnlySet<string> MoneyParameters = new HashSet<string>(StringComparer.Ordinal) { "amount" };

    /// <summary>The parameters as a reader without finance.read may see them.</summary>
    public static IReadOnlyDictionary<string, string> WithoutMoney(IReadOnlyDictionary<string, string> parameters) =>
        parameters.Keys.Any(MoneyParameters.Contains)
            ? parameters.Where(p => !MoneyParameters.Contains(p.Key)).ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal)
            : parameters;

    public static string Hours(decimal hours) => hours.ToString("0.##", CultureInfo.InvariantCulture);
}
