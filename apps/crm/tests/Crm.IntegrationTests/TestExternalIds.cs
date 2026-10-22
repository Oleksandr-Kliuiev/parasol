using System.Globalization;

namespace Crm.IntegrationTests;

/// <summary>
/// Numbers of the PowerOffice customers and products tests link their records to. Every class of a run shares one database, and
/// a random number from a narrow range met another test's now and then, so the second link answered 409: one counter for the
/// whole run hands out each number of a range once (the ranges the tests use are disjoint blocks or the same block).
/// </summary>
internal static class TestExternalIds
{
    private static long counter = Random.Shared.NextInt64(0, 1_000_000);

    /// <summary>A number from <paramref name="from"/> up to <paramref name="to"/> that no other test of this run gets.</summary>
    public static long Number(long from, long to) => from + Interlocked.Increment(ref counter) % (to - from);

    public static string Next(long from, long to) => Number(from, to).ToString(CultureInfo.InvariantCulture);
}
