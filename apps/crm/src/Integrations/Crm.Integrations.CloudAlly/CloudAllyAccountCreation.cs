using System.Buffers;
using System.Net;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

/// <summary>
/// The password CloudAlly requires for a new account (M43). Parasoll makes a random one for the request and keeps it nowhere — not in
/// the action, the journal or a log: the partner reaches the account through the partner portal, and the customer can set their own.
/// </summary>
internal static class CloudAllyAccountPassword
{
    private const string Lower = "abcdefghijkmnopqrstuvwxyz";
    private const string Upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    private const string Digits = "23456789";
    private const string Marks = "!#%+-=?@";

    private static readonly SearchValues<char>[] Classes =
        [SearchValues.Create(Lower), SearchValues.Create(Upper), SearchValues.Create(Digits), SearchValues.Create(Marks)];

    /// <summary>24 characters with a lower-case and an upper-case letter, a digit and a mark (the rule CloudAlly's reference gives resellers).</summary>
    public static string New()
    {
        while (true)
        {
            var password = RandomNumberGenerator.GetString(Lower + Upper + Digits + Marks, 24);
            if (Classes.All(c => password.AsSpan().IndexOfAny(c) >= 0))
            {
                return password;
            }
        }
    }
}

/// <summary>
/// Creates the customer's CloudAlly account (<c>account.create</c>, M43): <c>POST v2/resellers/accounts</c> with the CRM's name, the
/// account's e-mail address and a data center in the EU. CloudAlly keeps one account per address, so the address is our key: the
/// partner's accounts are searched for it before and after. What the API cannot do — the customer's Microsoft 365 consent and the
/// backup tasks — is done in CloudAlly afterwards, which the wizard says.
/// </summary>
internal sealed class CloudAllyCreateAccountAction(
    ICloudAllyClient client, IOptionsMonitor<CloudAllyOptions> options, ICustomersApi customers, IntegrationDbContext db, ExternalLinkService links,
    ExternalRecordStore records, IExternalEffectJournal journal)
    : CustomerCreationAction(customers, db, links, records, journal)
{
    public const string EmailParameter = "email";

    public const string RegionParameter = "region";

    /// <summary>The journal kind of the account POST, written under the CRM organization. The reference is CloudAlly's account id.</summary>
    public const string AccountEffect = "account-post";

    /// <summary>The data centers in the EU that CloudAlly's reference lists for an account (<c>region</c>).</summary>
    public static readonly string[] EuRegions = ["EU", "EU_FRANKFURT", "EU_PARIS", "EU_STOCKHOLM", "EU_ZURICH"];

    public override string System => CloudAllyTypes.System;

    public override string Kind => CloudAllyActionKinds.AccountCreate;

    protected override string VendorName => "CloudAlly";

    public override string ExternalType => CloudAllyTypes.Customer;

    protected override string EffectKind => AccountEffect;

    public override string? ConsoleUrl => Link(options.CurrentValue.ConsoleUrl);

    public override IReadOnlyDictionary<string, string?> Defaults(OrganizationSyncView organization) =>
        new Dictionary<string, string?> { [RegionParameter] = DefaultRegion(options.CurrentValue.AccountRegion), [EmailParameter] = null };

    /// <summary>The configured data center when it is one of the EU's, else plain EU.</summary>
    public static string DefaultRegion(string? configured) =>
        EuRegions.FirstOrDefault(r => string.Equals(r, configured?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? "EU";

    protected override CustomerCreationPlan Prepare(OrganizationSyncView organization, JsonElement parameters)
    {
        var email = Email(parameters);
        if (email is null)
        {
            return new CustomerCreationPlan("{}", [], new VendorActionBlock("VND_EMAIL_INVALID", "Give the e-mail address the CloudAlly account signs in with."));
        }

        var region = EuRegions.FirstOrDefault(r => string.Equals(r, Text(parameters, RegionParameter), StringComparison.Ordinal));
        if (region is null)
        {
            return new CustomerCreationPlan("{}", [], new VendorActionBlock("VND_REGION_INVALID", "Choose one of CloudAlly's data centers in the EU."));
        }

        return new CustomerCreationPlan(VendorActionRules.Canonical(new Dictionary<string, object?> { [EmailParameter] = email, [RegionParameter] = region }),
        [
            Effect("VND_EFFECT_CLOUDALLY_ACCOUNT_CREATE", ("name", organization.Name.Trim()), ("email", email), ("region", region)),
            Effect("VND_EFFECT_CUSTOMER_LINKED", ("vendor", "CloudAlly")),
            Effect("VND_EFFECT_CLOUDALLY_PASSWORD"),
            Effect("VND_EFFECT_CLOUDALLY_CONSENT_LATER"),
        ]);
    }

    protected override IQueryable<ExternalRecord> WithKey(IQueryable<ExternalRecord> saved, OrganizationSyncView organization, JsonElement parameters)
    {
        var email = Email(parameters);
        return saved.Where(r => r.Email == email);
    }

    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct)
    {
        var email = Email(parameters);
        var found = new List<VendorCustomerRecord>();
        await foreach (var account in client.GetAccountsAsync(ct))
        {
            if (string.Equals(account.Email?.Trim(), email, StringComparison.OrdinalIgnoreCase) && !Closed(account.Status))
            {
                found.Add(Record(account));
            }
        }

        return found;
    }

    protected override async Task<VendorCustomerRecord> CreateAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct)
    {
        var email = Email(parameters)!;
        var region = Text(parameters, RegionParameter)!;
        if (await client.CreateAccountAsync(email, organization.Name.Trim(), region, ct) is { Id.Length: > 0 } created)
        {
            return Record(created);
        }

        // CloudAlly answered without the account: it is found by its address, the way a later attempt would find it.
        var found = await FindAsync(organization, parameters, ct);
        return found.Count == 1
            ? found[0]
            : throw new CloudAllyApiException(HttpStatusCode.OK, "CloudAlly created the account without saying which; it is looked for again.");
    }

    protected override VendorFailure Classify(Exception exception, CancellationToken ct) => exception switch
    {
        CloudAllyApiException { Status: HttpStatusCode.TooManyRequests } => VendorFailure.Busy,
        CloudAllyApiException refused when (int)refused.Status is >= 400 and < 500 and not 408 => VendorFailure.Refused,
        _ => VendorFailure.Unknown,
    };

    protected override bool IsReadFailure(Exception exception, CancellationToken ct) => CloudAllyAction.IsReadFailure(exception, ct);

    /// <summary>The address in lower case, as the CRM stores addresses of external records; null when it is not one.</summary>
    private static string? Email(JsonElement parameters)
    {
        var text = Text(parameters, EmailParameter);
        return text is { Length: <= 254 } && MailAddress.TryCreate(text, out var address) && address.Address == text && address.Host.Contains('.', StringComparison.Ordinal)
            ? text.ToLowerInvariant()
            : null;
    }

    private static bool Closed(string? status) => status?.ToUpperInvariant() is "DELETED" or "UNSUBSCRIBED";

    private static VendorCustomerRecord Record(CaAccount account) => new(account.Id, CloudAllyMapping.Name(account), CloudAllyMapping.ToRecord(account));
}
