namespace Crm.SharedKernel.Text;

/// <summary>
/// An import answer lists a bounded number of warnings (DEV-12): when there are more, the last line says how many, so a file
/// with five hundred bad rows does not look like one with twenty.
/// </summary>
public static class WarningList
{
    public const int DefaultMax = 20;

    public static List<string> Capped(IEnumerable<string> warnings, int max = DefaultMax)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(max, 2);
        var all = warnings.ToList();
        if (all.Count <= max)
        {
            return all;
        }

        var shown = all.Take(max - 1).ToList();
        shown.Add($"…and {all.Count - shown.Count} more.");
        return shown;
    }
}
