using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Privacy.Contracts;

namespace Crm.Privacy.Features;

/// <summary>
/// The canonical form of an erasure plan (DEV-11): sorted, ids and actions only, so the plan a person approved can be
/// recognised by its SHA-256 when they carry it out — and refused if the data changed in between.
/// </summary>
internal static class PrivacyPlan
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>For files people read: the export.</summary>
    public static readonly JsonSerializerOptions IndentedJson = new(Json) { WriteIndented = true };

    public static IReadOnlyList<PlannedErasure> Canonical(IEnumerable<PlannedErasure> plan) =>
        plan.OrderBy(p => p.Record.Module, StringComparer.Ordinal)
            .ThenBy(p => p.Record.EntityType, StringComparer.Ordinal)
            .ThenBy(p => p.Record.EntityId)
            .ThenBy(p => p.DataClass, StringComparer.Ordinal)
            .ToList();

    public static string Serialize(IReadOnlyList<PlannedErasure> plan) => JsonSerializer.Serialize(plan, Json);

    public static IReadOnlyList<PlannedErasure> Deserialize(string json) => JsonSerializer.Deserialize<List<PlannedErasure>>(json, Json) ?? [];

    public static string Digest(string canonicalJson) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalJson)));
}
