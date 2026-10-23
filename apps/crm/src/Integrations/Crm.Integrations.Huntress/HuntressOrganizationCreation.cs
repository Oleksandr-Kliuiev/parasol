using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Operations;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// The organization key (M43): agents join a Huntress organization through it, so it goes into the install script, and it is our key
/// at Huntress, which keeps no reference of ours. Huntress takes any text up to 256 characters; Parasoll keeps to lower-case letters,
/// digits and hyphens, so the key reads the same in a script, a URL and Huntress's own pages.
/// </summary>
public static partial class HuntressOrganizationKey
{
    public const int MaxLength = 64;

    public static bool IsValid(string? key) => key is not null && Pattern().IsMatch(key);

    /// <summary>A key proposed from the customer's name: "Fjord IT AS" becomes <c>fjord-it</c> (the company form is left out).</summary>
    public static string Propose(string name)
    {
        var text = name.Trim().ToLowerInvariant()
            .Replace("æ", "ae", StringComparison.Ordinal).Replace("ø", "o", StringComparison.Ordinal).Replace("å", "a", StringComparison.Ordinal);
        var plain = new StringBuilder();
        foreach (var c in text.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark)
            {
                plain.Append(char.IsAsciiLetterOrDigit(c) ? c : ' ');
            }
        }

        var words = plain.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        if (words.Count > 1 && CompanyForms.Contains(words[^1]))
        {
            words.RemoveAt(words.Count - 1);
        }

        var key = string.Join('-', words);
        key = key.Length > MaxLength ? key[..MaxLength].TrimEnd('-') : key;
        return key.Length > 0 ? key : "kunde";
    }

    private static readonly HashSet<string> CompanyForms = new(StringComparer.Ordinal) { "as", "asa", "ans", "da", "sa", "ba", "enk", "nuf", "ks", "ltd", "ab", "aps", "oy", "gmbh", "inc", "llc" };

    [GeneratedRegex("^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")]
    private static partial Regex Pattern();
}

/// <summary>
/// Creates the customer's organization in Huntress (<c>organization.create</c>, M43): <c>POST organizations</c> with the CRM's name and
/// the organization key, which is our key at Huntress (<c>GET organizations?key=</c> finds it before and after). The agents still have
/// to be installed with that key — Huntress's script in the customer's Atera profile — which the wizard says and the API cannot do.
/// </summary>
internal sealed class HuntressCreateOrganizationAction(
    IHuntressActionClient client, IOptionsMonitor<HuntressOptions> options, ICustomersApi customers, IntegrationDbContext db, ExternalLinkService links, ExternalRecordStore records,
    IExternalEffectJournal journal)
    : CustomerCreationAction(customers, db, links, records, journal)
{
    public const string KeyParameter = "key";

    /// <summary>The journal kind of the organization POST, written under the CRM organization. The reference is Huntress's id.</summary>
    public const string OrganizationEffect = "organization-post";

    public override string System => HuntressTypes.System;

    public override string Kind => HuntressActionKinds.OrganizationCreate;

    protected override string VendorName => "Huntress";

    public override string ExternalType => HuntressTypes.Organization;

    protected override string EffectKind => OrganizationEffect;

    public override string? ConsoleUrl => Link(options.CurrentValue.ConsoleUrl);

    public override IReadOnlyDictionary<string, string?> Defaults(OrganizationSyncView organization) =>
        new Dictionary<string, string?> { [KeyParameter] = HuntressOrganizationKey.Propose(organization.Name) };

    protected override CustomerCreationPlan Prepare(OrganizationSyncView organization, JsonElement parameters)
    {
        var key = Text(parameters, KeyParameter);
        if (!HuntressOrganizationKey.IsValid(key))
        {
            return new CustomerCreationPlan("{}", [], new VendorActionBlock("VND_KEY_INVALID",
                $"Give the organization key: lower-case letters, digits and hyphens, at most {HuntressOrganizationKey.MaxLength} characters."));
        }

        return new CustomerCreationPlan(VendorActionRules.Canonical(new Dictionary<string, object?> { [KeyParameter] = key }),
        [
            Effect("VND_EFFECT_HUNTRESS_ORGANIZATION_CREATE", ("name", Name(organization)), ("key", key)),
            Effect("VND_EFFECT_CUSTOMER_LINKED", ("vendor", "Huntress")),
            Effect("VND_EFFECT_HUNTRESS_AGENTS_LATER", ("key", key)),
        ]);
    }

    // The saved payload is Huntress's organization as the client reads it, in camel case: {"key":"fjord-it", …}. The key holds no
    // wildcard of LIKE, so the pattern matches the key exactly.
    protected override IQueryable<ExternalRecord> WithKey(IQueryable<ExternalRecord> saved, OrganizationSyncView organization, JsonElement parameters)
    {
        var pattern = $"%\"key\":\"{Text(parameters, KeyParameter)}\"%";
        return saved.Where(r => EF.Functions.Like(r.Payload, pattern));
    }

    protected override async Task<IReadOnlyList<VendorCustomerRecord>> FindAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct) =>
        (await client.FindOrganizationsByKeyAsync(Text(parameters, KeyParameter)!, ct)).Select(Record).ToList();

    protected override async Task<VendorCustomerRecord> CreateAsync(OrganizationSyncView organization, JsonElement parameters, CancellationToken ct)
    {
        var key = Text(parameters, KeyParameter)!;
        if (await client.CreateOrganizationAsync(Name(organization), key, ct) is { } created)
        {
            return Record(created);
        }

        // Huntress answered without the organization: it is found by its key, the way a later attempt would find it. Whatever goes
        // wrong in that read, the create was taken, so the attempt stays open and the next one looks again.
        IReadOnlyList<HuntressOrganization> found;
        try
        {
            found = await client.FindOrganizationsByKeyAsync(key, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            throw new CustomerCreatedUnreadException("Huntress took the organization, but it could not be read back; it is looked for again.", ex);
        }

        return found.Count == 1
            ? Record(found[0])
            : throw new CustomerCreatedUnreadException("Huntress created the organization without saying which; it is looked for again.");
    }

    protected override VendorFailure Classify(Exception exception, CancellationToken ct) => exception switch
    {
        HuntressApiException busy when HuntressFailures.IsBusy(busy.Status) => VendorFailure.Busy,
        HuntressApiException refused when HuntressFailures.IsRejection(refused.Status) => VendorFailure.Refused,
        _ => VendorFailure.Unknown,
    };

    protected override bool IsReadFailure(Exception exception, CancellationToken ct) => HuntressFailures.IsReadFailure(exception, ct);

    /// <summary>Huntress takes a name of at most 256 characters.</summary>
    private static string Name(OrganizationSyncView organization) =>
        organization.Name.Trim() is { Length: > 256 } name ? name[..256] : organization.Name.Trim();

    private static VendorCustomerRecord Record(HuntressOrganization organization) =>
        new(organization.Id.ToString(CultureInfo.InvariantCulture), organization.Name, HuntressMapping.ToRecord(organization));
}
