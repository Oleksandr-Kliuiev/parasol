using System.Globalization;

namespace Crm.Service.Features;

/// <summary>
/// The keys that tell one customer's machines apart (M40), as the agents of different sources report them: the serial number,
/// the network adapters' MAC addresses and the host name. Each is brought to one spelling, and a value that names no machine (a
/// placeholder the manufacturer left in the firmware, a random or virtual adapter) is no key at all.
/// </summary>
internal static class MachineKeys
{
    /// <summary>NetBIOS keeps 15 characters of a computer name, so a longer DNS name and its NetBIOS form are one name.</summary>
    public const int HostnameLength = 15;

    /// <summary>Values firmware leaves in the serial number field when the manufacturer did not fill it in.</summary>
    private static readonly HashSet<string> SerialPlaceholders = new(StringComparer.Ordinal)
    {
        "TOBEFILLEDBYO.E.M.", "TOBEFILLEDBYOEM", "DEFAULTSTRING", "SYSTEMSERIALNUMBER", "CHASSISSERIALNUMBER",
        "BASEBOARDSERIALNUMBER", "SERIALNUMBER", "SERIAL", "NOTSPECIFIED", "NOTAPPLICABLE", "NOTAVAILABLE", "NOTDEFINED", "NONE",
        "NULL", "N/A", "NA", "UNKNOWN", "INVALID", "EMPTY", "DEFAULT", "OEM", "O.E.M.", "TBD", "TOBEDETERMINED", "SYSTEMPRODUCTNAME",
        "123456789", "1234567890", "0123456789", "12345678", "123456", "ABCDEFGHIJ",
    };

    /// <summary>
    /// The serial number in one spelling (upper case, no white space), or null when there is none or it is a placeholder such
    /// as "To be filled by O.E.M.", "Default string" or a row of one character.
    /// </summary>
    public static string? Serial(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var serial = string.Concat(value.Where(c => !char.IsWhiteSpace(c))).ToUpperInvariant();
        var significant = serial.Where(char.IsLetterOrDigit).ToList();
        if (significant.Count < 4 || significant.All(c => c == significant[0]) || SerialPlaceholders.Contains(serial) ||
            serial.StartsWith("TOBEFILLED", StringComparison.Ordinal) || serial.StartsWith("DEFAULT", StringComparison.Ordinal))
        {
            return null;
        }

        return serial;
    }

    /// <summary>
    /// The host name without its domain, in upper case and cut to the 15 characters NetBIOS keeps; null when there is none.
    /// </summary>
    public static string? Hostname(string? value)
    {
        var name = value?.Trim();
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        var dot = name.IndexOf('.', StringComparison.Ordinal);
        name = (dot >= 0 ? name[..dot] : name).Trim().ToUpperInvariant();
        return name.Length == 0 ? null : name.Length > HostnameLength ? name[..HostnameLength] : name;
    }

    /// <summary>
    /// A MAC address as twelve upper-case hex digits, or null when it is no address of one machine's adapter: not twelve hex digits,
    /// all zeros, a group (multicast or broadcast) address, or a locally administered one (random Wi-Fi addresses, virtual and
    /// container adapters), which another machine can carry as well.
    /// </summary>
    public static string? Mac(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var hex = string.Concat(value.Where(c => c is not (':' or '-' or '.') && !char.IsWhiteSpace(c))).ToUpperInvariant();
        if (hex.Length != 12 || !hex.All(char.IsAsciiHexDigit) || hex == "000000000000")
        {
            return null;
        }

        var first = byte.Parse(hex.AsSpan(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return (first & 0b11) == 0 ? hex : null;
    }

    /// <summary>The distinct MAC addresses of a list as <see cref="Mac"/> spells them, leaving out the ones that are no key.</summary>
    public static IReadOnlyList<string> Macs(IEnumerable<string?> values) =>
        values.Select(Mac).OfType<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();
}
