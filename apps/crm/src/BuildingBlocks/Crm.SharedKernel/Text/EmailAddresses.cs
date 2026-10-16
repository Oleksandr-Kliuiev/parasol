using System.Text.RegularExpressions;

namespace Crm.SharedKernel.Text;

/// <summary>
/// The shape of an e-mail address the CRM stores. FluentValidation's default <c>EmailAddress()</c> only asks for one "@", so a
/// double quote, a space or a line break would pass and later be built into a mailbox search or a header (F-G1-13). This one
/// accepts the atoms of RFC 5322 (and Unicode letters and digits, for Norwegian names and IDN domains) but no quote, space,
/// comma, angle bracket or control character.
/// </summary>
public static partial class EmailAddresses
{
    [GeneratedRegex(@"^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]{1,64}@[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?)+\z")]
    private static partial Regex Pattern();

    /// <summary>True for a plain address (at most 254 characters); null and the empty string are not addresses.</summary>
    public static bool IsValid(string? value) => value is { Length: > 0 and <= 254 } && Pattern().IsMatch(value);
}
