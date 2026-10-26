using System.Text.Json;
using Crm.Service.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Service.Domain;

/// <summary>
/// One Windows update of a device as its source reported it at the last complete read (M40): installed, with the time, or
/// available, with the source's status of it. A read replaces the device's updates as a whole; the source is the system of record.
/// </summary>
public sealed class DevicePatch : Entity
{
    public const int NameLength = 512;

    /// <summary>A device keeps at most this many updates of each kind: what a card can show, not a history.</summary>
    public const int MaxPerKind = 500;

    private DevicePatch() { }

    public Guid DeviceId { get; private set; }
    public bool Installed { get; private set; }
    public string? KbId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? Class { get; private set; }
    public DateTimeOffset? InstalledAt { get; private set; }
    public string? Status { get; private set; }

    public static DevicePatch From(Guid deviceId, bool installed, DevicePatchReading reading) => new()
    {
        DeviceId = deviceId,
        Installed = installed,
        KbId = Cut(reading.KbId, 32),
        Name = Cut(reading.Name, NameLength) ?? string.Empty,
        Class = Cut(reading.Class, 128),
        InstalledAt = installed ? reading.InstalledAt : null,
        Status = installed ? null : Cut(reading.Status, 64),
    };

    private static string? Cut(string? value, int length) =>
        value?.Trim() is { Length: > 0 } text ? text.Length > length ? text[..length] : text : null;
}

/// <summary>The disks of a device as the JSON its column keeps (M40); as many whole disks as fit.</summary>
internal static class DeviceDisks
{
    public const int Length = 2000;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string? Write(IReadOnlyList<DeviceDisk> disks)
    {
        var kept = disks.Where(d => d.Drive is not null || d.Total is not null).ToList();
        while (kept.Count > 0)
        {
            var text = JsonSerializer.Serialize(kept, Json);
            if (text.Length <= Length)
            {
                return text;
            }

            kept.RemoveAt(kept.Count - 1);
        }

        return null;
    }

    public static IReadOnlyList<DeviceDisk> Read(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<DeviceDisk>>(json, Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }
}
