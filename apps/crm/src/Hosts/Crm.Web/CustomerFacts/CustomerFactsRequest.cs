namespace Crm.Web.CustomerFacts;

/// <summary>The <c>ids</c> of a facts request: a page of the customer list, so 1 to <see cref="MaxIds"/> different organization ids.</summary>
public static class CustomerFactsRequest
{
    public const int MaxIds = 50;

    public const string InvalidCode = "CUS_FACTS_INVALID";

    public static readonly string InvalidMessage = $"Send 1 to {MaxIds} different organization ids, separated by commas.";

    /// <summary>The ids in the order they were sent, or null when the list is empty, too long, repeats an id or holds something that is no id.</summary>
    public static IReadOnlyList<Guid>? ParseIds(string? ids)
    {
        if (string.IsNullOrWhiteSpace(ids))
        {
            return null;
        }

        var parts = ids.Split(',', StringSplitOptions.TrimEntries);
        if (parts.Length > MaxIds)
        {
            return null;
        }

        var result = new List<Guid>(parts.Length);
        var seen = new HashSet<Guid>();
        foreach (var part in parts)
        {
            if (!Guid.TryParse(part, out var id) || !seen.Add(id))
            {
                return null;
            }

            result.Add(id);
        }

        return result;
    }
}
