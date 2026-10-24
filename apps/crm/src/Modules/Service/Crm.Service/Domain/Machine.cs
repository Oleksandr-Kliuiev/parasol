using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// One computer of a customer (M40): the devices (agents) of every source that belong to it. A machine has no data of its own;
/// its name, type, system and last contact are those of its devices, refreshed whenever they are matched again. Not audited: the
/// sources are the system of record, and what people decide about it is kept in <see cref="MachineLinkDecision"/>.
/// </summary>
public sealed class Machine : Entity
{
    private Machine(Guid id) : base(id) { }

    public Guid OrganizationId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public DeviceType Type { get; private set; }
    public string? Os { get; private set; }
    public bool Online { get; private set; }
    public DateTimeOffset? LastSeenAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }

    /// <summary>Set when no device of the machine is reported any more; the machine is then shown only as history.</summary>
    public DateTimeOffset? RemovedAt { get; private set; }

    public static Machine Create(Guid id, Guid organizationId, DateTimeOffset now) =>
        new(id) { OrganizationId = organizationId, CreatedAt = now };

    /// <summary>
    /// Takes the machine's facts from its devices: the current devices when it has any, else the last ones reported. The one seen
    /// most recently names it. Returns false when nothing changed.
    /// </summary>
    public bool Refresh(IReadOnlyCollection<Device> devices)
    {
        var current = devices.Where(d => d.RemovedAt is null).ToList();
        var shown = current.Count > 0 ? current : devices.ToList();
        if (shown.Count == 0)
        {
            return false;
        }

        var lead = shown.OrderByDescending(d => d.LastSeenAt ?? DateTimeOffset.MinValue).ThenByDescending(d => d.Online)
            .ThenBy(d => d.FirstSeenAt).ThenBy(d => d.Id).First();
        var before = (Name, Type, Os, Online, LastSeenAt, RemovedAt);
        Name = lead.MachineName;
        Type = lead.Type;
        Os = lead.Os;
        Online = current.Any(d => d.Online);
        LastSeenAt = shown.Max(d => d.LastSeenAt);
        RemovedAt = current.Count > 0 ? null : devices.Max(d => d.RemovedAt);
        return before != (Name, Type, Os, Online, LastSeenAt, RemovedAt);
    }
}

/// <summary>What a person said about two devices of one customer: they are one machine, or two different machines.</summary>
public enum MachineLinkKind
{
    Same,
    Different,
}

/// <summary>Why two devices may be one machine.</summary>
[Flags]
public enum MachineEvidence
{
    None = 0,
    Serial = 1,
    Mac = 2,
    Name = 4,

    /// <summary>Both carry a serial number and the numbers differ, while another key matches (a replaced mainboard, a reused name).</summary>
    SerialConflict = 8,
}

/// <summary>
/// A person's decision about a pair of devices (M40): the matcher applies it before any rule, and it survives every read. One row
/// per pair, the smaller id first; a later decision about the same pair changes the row, and the audit keeps both.
/// </summary>
public sealed class MachineLinkDecision : AuditableEntity
{
    private MachineLinkDecision() { }

    public Guid OrganizationId { get; private set; }
    public Guid DeviceId { get; private set; }
    public Guid OtherDeviceId { get; private set; }
    public MachineLinkKind Kind { get; private set; }

    public static MachineLinkDecision For(Guid organizationId, Guid deviceId, Guid otherDeviceId, MachineLinkKind kind)
    {
        var (first, second) = Order(deviceId, otherDeviceId);
        return new MachineLinkDecision { OrganizationId = organizationId, DeviceId = first, OtherDeviceId = second, Kind = kind };
    }

    /// <summary>Returns false when the pair already had this decision.</summary>
    public bool Decide(MachineLinkKind kind)
    {
        if (Kind == kind)
        {
            return false;
        }

        Kind = kind;
        return true;
    }

    /// <summary>The order a pair is stored in, so a pair has one row whichever device a person started from.</summary>
    public static (Guid First, Guid Second) Order(Guid a, Guid b) => a.CompareTo(b) <= 0 ? (a, b) : (b, a);
}

/// <summary>
/// Two machines of one customer that share a key but that no rule may join (M40): a person decides. Written by the matcher and
/// written again on every match; <see cref="FoundAt"/> stays while the proposal does.
/// </summary>
public sealed class MachineProposal : Entity
{
    private MachineProposal() { }

    public Guid OrganizationId { get; private set; }

    /// <summary>The machine seen later, which would join <see cref="OtherMachineId"/>.</summary>
    public Guid MachineId { get; private set; }

    public Guid OtherMachineId { get; private set; }

    /// <summary>The pair of devices with the strongest evidence; a decision about the proposal is recorded for them.</summary>
    public Guid DeviceId { get; private set; }

    public Guid OtherDeviceId { get; private set; }
    public MachineEvidence Evidence { get; private set; }
    public DateTimeOffset FoundAt { get; private set; }

    public static MachineProposal Found(
        Guid organizationId, Guid machineId, Guid otherMachineId, Guid deviceId, Guid otherDeviceId, MachineEvidence evidence, DateTimeOffset now) =>
        new()
        {
            OrganizationId = organizationId,
            MachineId = machineId,
            OtherMachineId = otherMachineId,
            DeviceId = deviceId,
            OtherDeviceId = otherDeviceId,
            Evidence = evidence,
            FoundAt = now,
        };

    /// <summary>The same two machines again, perhaps on other evidence. Returns false when nothing changed.</summary>
    public bool Update(Guid deviceId, Guid otherDeviceId, MachineEvidence evidence)
    {
        if ((DeviceId, OtherDeviceId, Evidence) == (deviceId, otherDeviceId, evidence))
        {
            return false;
        }

        (DeviceId, OtherDeviceId, Evidence) = (deviceId, otherDeviceId, evidence);
        return true;
    }
}
