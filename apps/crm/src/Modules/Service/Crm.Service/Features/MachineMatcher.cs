using Crm.Service.Domain;

namespace Crm.Service.Features;

/// <summary>
/// One current agent of a source (an Atera agent; a Huntress agent from M41) as the machine matcher sees it. The keys are as the
/// source reported them; <paramref name="MachineId"/> is the machine the device belongs to now, null for one never matched.
/// </summary>
internal sealed record MatchDevice(
    Guid Id,
    string System,
    string? Hostname,
    string? SerialNumber,
    IReadOnlyCollection<string> MacAddresses,
    DateTimeOffset FirstSeenAt,
    Guid? MachineId = null);

/// <summary>A person's decision about a pair of devices; it is applied before any rule and survives every read.</summary>
internal sealed record MatchDecision(Guid DeviceId, Guid OtherDeviceId, MachineLinkKind Kind);

/// <summary>
/// Two machines a person should look at: <paramref name="MachineId"/> is the newer one, which would join
/// <paramref name="OtherMachineId"/>. The devices are the pair with the strongest evidence.
/// </summary>
internal sealed record ProposedLink(Guid MachineId, Guid OtherMachineId, Guid DeviceId, Guid OtherDeviceId, MachineEvidence Evidence);

/// <summary>The machine of every device, the machines this match made, and the pairs a person should decide.</summary>
internal sealed record MachineMatch(IReadOnlyDictionary<Guid, Guid> MachineOfDevice, IReadOnlyList<Guid> NewMachines, IReadOnlyList<ProposedLink> Proposals);

/// <summary>
/// Groups one customer's devices into machines (M40), as a pure function of the devices and the decisions people made. Only
/// devices of one customer are ever compared. Order of work:
/// <list type="number">
/// <item>A person's decisions come first: "same machine" joins two devices, "different machines" keeps them apart for good.</item>
/// <item>Serial number, a shared MAC address and the host name all match: one machine.</item>
/// <item>The host name is carried by exactly two machines, of different sources, whose serial numbers do not contradict: one machine.</item>
/// <item>Any other match of a key (serial number, MAC address or host name) is a proposal for a person, never a guess.</item>
/// </list>
/// A machine keeps its id while most of its devices stay together, so links to it survive a read.
/// </summary>
internal static class MachineMatcher
{
    /// <summary>
    /// A MAC address that devices of more host names than this carry is a shared adapter (a docking station on a hot desk, a VPN),
    /// not an identity. Devices of one name count once: the agents of one computer all report its adapters.
    /// </summary>
    public const int SharedMacLimit = 2;

    /// <summary>
    /// A serial number or host name more devices than this carry names no one computer (a default name, a placeholder no list
    /// knows): it proposes nothing, while devices that also match by the other keys still join.
    /// </summary>
    public const int CrowdedKeyLimit = 5;

    public static MachineMatch Match(IReadOnlyList<MatchDevice> devices, IReadOnlyCollection<MatchDecision> decisions, Func<Guid> newMachineId)
    {
        var ordered = devices.DistinctBy(d => d.Id).OrderBy(d => d.FirstSeenAt).ThenBy(d => d.Id).ToList();
        var position = ordered.Select((d, i) => (d.Id, i)).ToDictionary(x => x.Id, x => x.i);
        var keys = Keys(ordered);
        var sets = new DeviceSets(ordered.Count);

        var apart = new HashSet<(int, int)>();
        foreach (var decision in decisions.Where(d => d.Kind == MachineLinkKind.Different))
        {
            if (position.TryGetValue(decision.DeviceId, out var a) && position.TryGetValue(decision.OtherDeviceId, out var b) && a != b)
            {
                apart.Add(Pair(a, b));
            }
        }

        foreach (var decision in decisions.Where(d => d.Kind == MachineLinkKind.Same))
        {
            if (position.TryGetValue(decision.DeviceId, out var a) && position.TryGetValue(decision.OtherDeviceId, out var b) &&
                sets.CanJoin(a, b, apart))
            {
                sets.Join(a, b);
            }
        }

        var evidence = Evidence(keys);
        foreach (var (a, b, found) in evidence.Where(e => e.Found.HasFlag(MachineEvidence.Serial | MachineEvidence.Mac | MachineEvidence.Name)))
        {
            if (sets.CanJoin(a, b, apart) && !SerialsConflict(sets, keys, a, b))
            {
                sets.Join(a, b);
            }
        }

        JoinByUniqueName(ordered, keys, sets, apart);

        var machineOf = new Dictionary<Guid, Guid>(ordered.Count);
        var created = new List<Guid>();
        var claimed = new HashSet<Guid>();
        var machineOfSet = new Dictionary<int, Guid>();
        // The oldest machine chooses first: the id most of its devices already carry, so a machine keeps its id.
        foreach (var members in Enumerable.Range(0, ordered.Count).GroupBy(sets.Find).OrderBy(g => g.Min()))
        {
            var id = members.Where(i => ordered[i].MachineId is not null)
                .GroupBy(i => ordered[i].MachineId!.Value).OrderByDescending(g => g.Count()).ThenBy(g => g.Min())
                .Select(g => (Guid?)g.Key).FirstOrDefault(candidate => !claimed.Contains(candidate!.Value));
            if (id is null)
            {
                id = newMachineId();
                created.Add(id.Value);
            }

            claimed.Add(id.Value);
            machineOfSet[members.Key] = id.Value;
            foreach (var i in members)
            {
                machineOf[ordered[i].Id] = id.Value;
            }
        }

        return new MachineMatch(machineOf, created, Proposals(ordered, evidence, sets, apart, machineOfSet));
    }

    /// <summary>The keys of every device in one spelling; a MAC address of too many names is dropped from all of them.</summary>
    private static List<DeviceKeys> Keys(List<MatchDevice> devices)
    {
        var macs = devices.Select(d => MachineKeys.Macs(d.MacAddresses)).ToList();
        // A device without a name counts as a name of its own.
        var shared = devices.SelectMany((d, i) => macs[i].Select(m => (Mac: m, Name: MachineKeys.Hostname(d.Hostname) ?? "#" + i)))
            .GroupBy(x => x.Mac, StringComparer.Ordinal)
            .Where(g => g.Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() > SharedMacLimit)
            .Select(g => g.Key).ToHashSet(StringComparer.Ordinal);
        return devices.Select((d, i) => new DeviceKeys(
            d.System, MachineKeys.Hostname(d.Hostname), MachineKeys.Serial(d.SerialNumber),
            macs[i].Where(m => !shared.Contains(m)).ToHashSet(StringComparer.Ordinal))).ToList();
    }

    /// <summary>Every pair of devices that shares a key, strongest evidence first, then in the order the devices were first seen.</summary>
    private static List<(int A, int B, MachineEvidence Found)> Evidence(List<DeviceKeys> keys)
    {
        var candidates = new HashSet<(int, int)>();
        void Bucket(IEnumerable<(string Key, int Index)> values)
        {
            foreach (var group in values.GroupBy(v => v.Key, StringComparer.Ordinal))
            {
                var members = group.Select(v => v.Index).Distinct().ToList();
                if (members.Count > CrowdedKeyLimit)
                {
                    continue;
                }

                for (var x = 0; x < members.Count; x++)
                {
                    for (var y = x + 1; y < members.Count; y++)
                    {
                        candidates.Add(Pair(members[x], members[y]));
                    }
                }
            }
        }

        Bucket(keys.Select((k, i) => (k.Serial!, i)).Where(v => v.Item1 is not null));
        Bucket(keys.Select((k, i) => (k.Hostname!, i)).Where(v => v.Item1 is not null));
        Bucket(keys.SelectMany((k, i) => k.Macs.Select(m => (m, i))));
        return candidates.Select(p => (p.Item1, p.Item2, Found: Compare(keys[p.Item1], keys[p.Item2])))
            .Where(p => (p.Found & ~MachineEvidence.SerialConflict) != MachineEvidence.None)
            .OrderByDescending(p => Strength(p.Found)).ThenBy(p => p.Item1).ThenBy(p => p.Item2).ToList();
    }

    private static MachineEvidence Compare(DeviceKeys a, DeviceKeys b)
    {
        var found = MachineEvidence.None;
        if (a.Serial is not null && b.Serial is not null)
        {
            found |= a.Serial == b.Serial ? MachineEvidence.Serial : MachineEvidence.SerialConflict;
        }

        if (a.Macs.Overlaps(b.Macs))
        {
            found |= MachineEvidence.Mac;
        }

        if (a.Hostname is not null && a.Hostname == b.Hostname)
        {
            found |= MachineEvidence.Name;
        }

        return found;
    }

    /// <summary>A serial number outweighs a MAC address, which outweighs a name; a conflict of serial numbers weakens all.</summary>
    private static int Strength(MachineEvidence found) =>
        (found.HasFlag(MachineEvidence.Serial) ? 4 : 0) + (found.HasFlag(MachineEvidence.Mac) ? 2 : 0) + (found.HasFlag(MachineEvidence.Name) ? 1 : 0) -
        (found.HasFlag(MachineEvidence.SerialConflict) ? 8 : 0);

    /// <summary>
    /// Joins two machines that are the only ones carrying a host name, when they have no source in common and their serial numbers
    /// do not contradict: the Atera agent and, from M41, the Huntress agent of one computer. Two devices of one source with one name
    /// are not unique; they join only when every key matches, else a person decides.
    /// </summary>
    private static void JoinByUniqueName(List<MatchDevice> devices, List<DeviceKeys> keys, DeviceSets sets, HashSet<(int, int)> apart)
    {
        var byName = Enumerable.Range(0, devices.Count).Where(i => keys[i].Hostname is not null)
            .GroupBy(i => keys[i].Hostname!, StringComparer.Ordinal);
        foreach (var name in byName.OrderBy(g => g.Min()))
        {
            var machines = name.GroupBy(sets.Find).ToList();
            if (machines.Count != 2)
            {
                continue;
            }

            var (a, b) = (machines[0].Min(), machines[1].Min());
            var systemsA = sets.Members(a).Select(i => devices[i].System).ToHashSet(StringComparer.Ordinal);
            if (sets.Members(b).Any(i => systemsA.Contains(devices[i].System)) || !sets.CanJoin(a, b, apart) || SerialsConflict(sets, keys, a, b))
            {
                continue;
            }

            sets.Join(a, b);
        }
    }

    /// <summary>Both machines know serial numbers and share none of them.</summary>
    private static bool SerialsConflict(DeviceSets sets, List<DeviceKeys> keys, int a, int b)
    {
        var serialsA = sets.Members(a).Select(i => keys[i].Serial).OfType<string>().ToHashSet(StringComparer.Ordinal);
        var serialsB = sets.Members(b).Select(i => keys[i].Serial).OfType<string>().ToHashSet(StringComparer.Ordinal);
        return serialsA.Count > 0 && serialsB.Count > 0 && !serialsA.Overlaps(serialsB);
    }

    /// <summary>One proposal per pair of machines that share a key and were not kept apart, the newer machine first.</summary>
    private static List<ProposedLink> Proposals(
        List<MatchDevice> devices, List<(int A, int B, MachineEvidence Found)> evidence, DeviceSets sets, HashSet<(int, int)> apart,
        Dictionary<int, Guid> machineOfSet)
    {
        var proposals = new Dictionary<(int, int), ProposedLink>();
        foreach (var (a, b, found) in evidence)
        {
            var (setA, setB) = (sets.Find(a), sets.Find(b));
            if (!sets.CanJoin(a, b, apart))
            {
                continue;
            }

            // The machine first seen later is the one that would join: its oldest device is the newer one.
            var (newer, older, device, other) = sets.Members(a).Min() > sets.Members(b).Min() ? (setA, setB, a, b) : (setB, setA, b, a);
            var key = (newer, older);
            if (proposals.TryGetValue(key, out var known))
            {
                proposals[key] = known with { Evidence = known.Evidence | found };
                continue;
            }

            proposals[key] = new ProposedLink(machineOfSet[newer], machineOfSet[older], devices[device].Id, devices[other].Id, found);
        }

        return proposals.Values.ToList();
    }

    private static (int, int) Pair(int a, int b) => a < b ? (a, b) : (b, a);

    private sealed record DeviceKeys(string System, string? Hostname, string? Serial, HashSet<string> Macs);

    /// <summary>Disjoint sets of device positions (union-find) that also know their members.</summary>
    private sealed class DeviceSets
    {
        private readonly int[] parent;
        private readonly Dictionary<int, List<int>> members = [];

        public DeviceSets(int count)
        {
            parent = Enumerable.Range(0, count).ToArray();
            for (var i = 0; i < count; i++)
            {
                members[i] = [i];
            }
        }

        public int Find(int i)
        {
            while (parent[i] != i)
            {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }

            return i;
        }

        public List<int> Members(int i) => members[Find(i)];

        public void Join(int a, int b)
        {
            var (rootA, rootB) = (Find(a), Find(b));
            if (rootA == rootB)
            {
                return;
            }

            // The set of the device seen first stays the root, so a set is always named by its oldest device.
            var (root, child) = rootA < rootB ? (rootA, rootB) : (rootB, rootA);
            parent[child] = root;
            members[root].AddRange(members[child]);
            members.Remove(child);
        }

        /// <summary>The two sets are not one yet and a person kept no device of the one apart from a device of the other.</summary>
        public bool CanJoin(int a, int b, HashSet<(int, int)> apart)
        {
            var (rootA, rootB) = (Find(a), Find(b));
            return rootA != rootB && !members[rootA].Any(x => members[rootB].Any(y => apart.Contains(Pair(x, y))));
        }
    }
}
