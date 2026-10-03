using System.Text.Json.Serialization.Metadata;

namespace Crm.Authorization;

/// <summary>
/// Marks a response DTO property that is only serialized for users holding <see cref="Permission"/>.
/// Enforced server-side by <see cref="SensitiveDataJsonModifier"/> (docs/06-security.md SEC-AZ-04).
/// </summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class SensitiveDataAttribute(string permission) : Attribute
{
    public string Permission { get; } = permission;
}

public static class SensitiveDataJsonModifier
{
    /// <param name="permissionCheck">Returns whether the current caller holds the permission.</param>
    public static Action<JsonTypeInfo> Create(Func<string, bool> permissionCheck) => typeInfo =>
    {
        if (typeInfo.Kind != JsonTypeInfoKind.Object)
        {
            return;
        }

        foreach (JsonPropertyInfo property in typeInfo.Properties)
        {
            var attribute = property.AttributeProvider?
                .GetCustomAttributes(typeof(SensitiveDataAttribute), inherit: true)
                .OfType<SensitiveDataAttribute>()
                .FirstOrDefault();
            if (attribute is null)
            {
                continue;
            }

            var inner = property.ShouldSerialize;
            property.ShouldSerialize = (owner, value) =>
                permissionCheck(attribute.Permission) && (inner?.Invoke(owner, value) ?? true);
        }
    };
}
