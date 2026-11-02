using System.Text.RegularExpressions;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>The SharePoint side of the customer folders (FR-DOC-01, M47): the system and type the links have carried since S10.</summary>
public static class SharePointTypes
{
    /// <summary>The system of the folder links; the Entra syncs run under <see cref="EntraUserSyncJob.System"/> instead.</summary>
    public const string System = "graph";

    public const string Folder = "Folder";
}

/// <summary>The kinds of action people may ask of SharePoint (M47), each off until <c>SharePoint:EnabledActions</c> lists it.</summary>
public static class SharePointActionKinds
{
    /// <summary>The customer's folder, created in the root folder and linked at once (the documents tab, the "Connect services" wizard).</summary>
    public const string FolderCreate = "folder.create";

    public static readonly string[] All = [FolderCreate];
}

/// <summary>
/// How the CRM names a customer's folder and recognizes the names it made. A folder the CRM made is called "{name} ({org number})";
/// a folder a person made, or renamed, keeps its name: the CRM renames only folders that still carry its own form for the
/// organization, so linking the old folders of a library never renames them (M47).
/// </summary>
public static partial class SharePointNames
{
    /// <summary>Characters SharePoint does not allow in a file or folder name.</summary>
    private const string Forbidden = "\"*:<>?/\\|";

    private const int MaxLength = 120;

    /// <summary>Company forms people leave out when they name a folder ("Kviknes Hotel" for "Kviknes Hotel AS").</summary>
    private static readonly HashSet<string> LegalForms =
        new(["as", "asa", "enk", "da", "ans", "sa", "ba", "nuf", "ks", "iks"], StringComparer.OrdinalIgnoreCase);

    /// <summary>"Åsane Rør AS (912345678)" — the org number keeps two customers with the same name apart.</summary>
    public static string FolderName(string organizationName, string? orgNumber)
    {
        if (string.IsNullOrWhiteSpace(orgNumber))
        {
            return Cut(Clean(organizationName));
        }

        // The name gives way, never the org number: it is how the CRM knows its own folder again.
        var suffix = $" ({orgNumber.Trim()})";
        return Cut(Clean(organizationName), MaxLength - suffix.Length) + suffix;
    }

    /// <summary>
    /// The names a person would have given the customer's folder before the CRM did: the organization's name as it is, and without
    /// its company form. A folder under one of them is the customer's own, and the CRM never makes a second one beside it.
    /// </summary>
    public static IReadOnlyList<string> PlainNames(string organizationName)
    {
        var full = Cut(Clean(organizationName));
        var words = full.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var shorter = words.Length > 1 && LegalForms.Contains(words[^1]) ? string.Join(' ', words[..^1]) : full;
        return shorter == full ? [full] : [full, shorter];
    }

    /// <summary>The org number at the end of a folder name the CRM made ("… (912345678)"), else null.</summary>
    public static string? OrgNumberOf(string? folderName) =>
        folderName is not null && TrailingOrgNumber().Match(folderName) is { Success: true } match ? match.Groups[1].Value : null;

    /// <summary>The folder name without a trailing org number, for matching it against the organizations' names.</summary>
    public static string WithoutOrgNumber(string folderName) =>
        TrailingOrgNumber().Match(folderName) is { Success: true } match ? folderName[..match.Index].TrimEnd() : folderName.Trim();

    /// <summary>
    /// Whether the folder carries the CRM's own form for this organization (its org number at the end). Only such a folder follows a
    /// rename of the organization; a folder a person named is never renamed.
    /// </summary>
    public static bool IsOwnName(string? folderName, string? orgNumber) =>
        !string.IsNullOrWhiteSpace(orgNumber) && OrgNumberOf(folderName) == orgNumber.Trim();

    /// <summary>The root folder setting as a path inside the library: trimmed, without leading or trailing slashes ("" = the library itself).</summary>
    public static string RootPath(string? rootFolder) => string.Join('/', Segments(rootFolder));

    /// <summary>
    /// The Graph address of an item by its path under the root folder: <c>drives/{drive}/root:/Kunder/Name:</c>, each segment escaped;
    /// the library's root itself when there is no path. <paramref name="suffix"/> follows the path (<c>/children</c>).
    /// </summary>
    public static string ItemAddress(string driveId, string? rootFolder, string? name = null, string suffix = "")
    {
        var segments = Segments(rootFolder).Concat(name is null ? [] : [name]).ToList();
        return segments.Count == 0
            ? $"drives/{Uri.EscapeDataString(driveId)}/root{suffix}"
            : $"drives/{Uri.EscapeDataString(driveId)}/root:/{string.Join('/', segments.Select(Uri.EscapeDataString))}:{suffix}";
    }

    private static string[] Segments(string? path) =>
        (path ?? string.Empty).Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string Clean(string organizationName) =>
        string.Join(' ', new string(organizationName.Select(c => Forbidden.Contains(c, StringComparison.Ordinal) ? '-' : c).ToArray())
            .Split(' ', StringSplitOptions.RemoveEmptyEntries));

    private static string Cut(string name, int length = MaxLength) => name.Length > length ? name[..length].TrimEnd() : name;

    [GeneratedRegex(@"\((\d{9})\)\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex TrailingOrgNumber();
}
