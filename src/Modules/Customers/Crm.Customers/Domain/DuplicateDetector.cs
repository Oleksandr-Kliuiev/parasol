using System.Globalization;
using System.Text;

namespace Crm.Customers.Domain;

public enum DuplicateReason
{
    SameName,
    SharedDomain,
    SameEmailDomain,
    SamePhone,
}

public sealed record DuplicateCandidate(Guid Id, string Name, string? OrgNumber, string? Email, string? Phone, IReadOnlyCollection<string> Domains);

public sealed record DuplicatePair(Guid FirstId, Guid SecondId, IReadOnlyList<DuplicateReason> Reasons);

/// <summary>
/// Finds likely duplicate organizations (BR-CUS-06) without the database: organizations with two different org numbers
/// are distinct legal entities and never reported, even when they share a domain (group companies).
/// </summary>
public static class DuplicateDetector
{
    private static readonly HashSet<string> LegalFormSuffixes =
        new(["as", "asa", "enk", "da", "ans", "sa", "ba", "nuf", "ks", "iks", "ab", "aps", "gmbh", "ltd", "a/s", "stiftelse", "forening"], StringComparer.Ordinal);

    /// <summary>Public mailbox providers: sharing one of these says nothing about being the same company.</summary>
    private static readonly HashSet<string> PublicMailDomains =
        new(["gmail.com", "outlook.com", "hotmail.com", "live.com", "live.no", "online.no", "icloud.com", "yahoo.com", "me.com", "msn.com", "proton.me", "protonmail.com"], StringComparer.Ordinal);

    public static string NormalizeName(string name)
    {
        var lower = name.ToLower(CultureInfo.GetCultureInfo("nb-NO")).Replace("a/s", " ", StringComparison.Ordinal);
        var cleaned = new StringBuilder(lower.Length);
        foreach (var c in lower)
        {
            cleaned.Append(char.IsLetterOrDigit(c) ? c : ' ');
        }

        var words = cleaned.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        while (words.Count > 1 && LegalFormSuffixes.Contains(words[^1]))
        {
            words.RemoveAt(words.Count - 1);
        }

        return string.Join(' ', words);
    }

    public static IReadOnlyList<DuplicatePair> Find(IReadOnlyCollection<DuplicateCandidate> organizations, ISet<(Guid, Guid)> dismissed)
    {
        var reasons = new Dictionary<(Guid, Guid), SortedSet<DuplicateReason>>();
        var byId = organizations.ToDictionary(o => o.Id);

        void Group(Func<DuplicateCandidate, IEnumerable<string>> keys, DuplicateReason reason)
        {
            var groups = organizations
                .SelectMany(o => keys(o).Distinct(StringComparer.Ordinal).Select(key => (key, o.Id)))
                .GroupBy(x => x.key, x => x.Id, StringComparer.Ordinal)
                .Where(g => g.Count() is > 1 and <= 20); // very large groups are noise (e.g. a shared helpdesk domain)

            foreach (var group in groups)
            {
                var ids = group.Distinct().Order().ToList();
                for (int i = 0; i < ids.Count; i++)
                {
                    for (int j = i + 1; j < ids.Count; j++)
                    {
                        var pair = (ids[i], ids[j]);
                        var a = byId[pair.Item1];
                        var b = byId[pair.Item2];
                        if (dismissed.Contains(pair) || (a.OrgNumber is not null && b.OrgNumber is not null && a.OrgNumber != b.OrgNumber))
                        {
                            continue;
                        }

                        if (!reasons.TryGetValue(pair, out var set))
                        {
                            reasons[pair] = set = [];
                        }

                        set.Add(reason);
                    }
                }
            }
        }

        Group(o => NormalizeName(o.Name) is { Length: >= 3 } n ? [n] : [], DuplicateReason.SameName);
        Group(o => o.Domains, DuplicateReason.SharedDomain);
        Group(o => EmailDomain(o.Email) is { } d ? [d] : [], DuplicateReason.SameEmailDomain);
        Group(o => PhoneDigits(o.Phone) is { } p ? [p] : [], DuplicateReason.SamePhone);

        return reasons
            .Select(r => new DuplicatePair(r.Key.Item1, r.Key.Item2, r.Value.ToList()))
            .OrderByDescending(p => p.Reasons.Count)
            .ThenBy(p => p.Reasons[0])
            .ToList();
    }

    /// <summary>Reasons why an external record may be the same company as a CRM organization.</summary>
    public static IReadOnlyList<DuplicateReason> Compare(DuplicateCandidate external, DuplicateCandidate organization)
    {
        var reasons = new List<DuplicateReason>();
        var name = NormalizeName(external.Name);
        if (name.Length >= 3 && name == NormalizeName(organization.Name))
        {
            reasons.Add(DuplicateReason.SameName);
        }

        if (external.Domains.Intersect(organization.Domains, StringComparer.Ordinal).Any())
        {
            reasons.Add(DuplicateReason.SharedDomain);
        }

        if (EmailDomain(external.Email) is { } d && d == EmailDomain(organization.Email))
        {
            reasons.Add(DuplicateReason.SameEmailDomain);
        }

        if (PhoneDigits(external.Phone) is { } p && p == PhoneDigits(organization.Phone))
        {
            reasons.Add(DuplicateReason.SamePhone);
        }

        return reasons;
    }

    public static string? EmailDomainOf(string? email) => EmailDomain(email);

    public static (Guid, Guid) PairKey(Guid a, Guid b) => a.CompareTo(b) < 0 ? (a, b) : (b, a);

    private static string? EmailDomain(string? email)
    {
        var at = email?.LastIndexOf('@') ?? -1;
        if (at < 0)
        {
            return null;
        }

        var domain = email![(at + 1)..].ToLowerInvariant();
        return PublicMailDomains.Contains(domain) ? null : domain;
    }

    private static string? PhoneDigits(string? phone)
    {
        if (phone is null)
        {
            return null;
        }

        var digits = new string(phone.Where(char.IsAsciiDigit).ToArray());
        if (digits.StartsWith("0047", StringComparison.Ordinal))
        {
            digits = digits[4..];
        }
        else if (digits.Length == 10 && digits.StartsWith("47", StringComparison.Ordinal))
        {
            digits = digits[2..];
        }

        return digits.Length >= 8 ? digits : null;
    }
}
