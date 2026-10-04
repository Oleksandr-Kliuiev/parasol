using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;

namespace Crm.Privacy.Features;

/// <summary>
/// The deletion manifest (DEV-11-AC06): which records an erasure covered and how, what it kept and why, and the suppressions
/// it left — ids, actions and keyed hashes only, so it can live outside the database and survive a restore without carrying
/// any of the erased data.
/// </summary>
internal static class ManifestContent
{
    public const int CurrentVersion = 1;

    public sealed record Document(
        int Version,
        string Installation,
        Guid ManifestId,
        Guid CaseId,
        string CaseNumber,
        DataSubjectKind SubjectKind,
        Guid SubjectId,
        DateTimeOffset ExecutedAt,
        IReadOnlyList<ErasedRecord> Records,
        IReadOnlyList<PlannedErasure> Retained,
        IReadOnlyList<SuppressionEntry> Suppressions);

    public sealed record SuppressionEntry(SuppressionKind Kind, string Value);

    public static (string Json, string Sha256) Create(
        Guid manifestId, string installation, PrivacyCase privacyCase, IReadOnlyList<PlannedErasure> plan, IReadOnlyList<ErasedRecord> erased,
        IEnumerable<Suppression> suppressions, DateTimeOffset executedAt)
    {
        var document = new Document(
            CurrentVersion, installation, manifestId, privacyCase.Id, privacyCase.Number, privacyCase.SubjectKind, privacyCase.SubjectId, executedAt,
            erased.Where(e => e.Action != ErasureAction.Retain).ToList(),
            plan.Where(p => p.Action == ErasureAction.Retain).ToList(),
            suppressions.Select(s => new SuppressionEntry(s.Kind, s.Value)).Distinct().ToList());
        var json = JsonSerializer.Serialize(document, PrivacyPlan.Json);
        return (json, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(json))));
    }

    public static Document? Parse(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<Document>(json, PrivacyPlan.Json) is { Version: > 0 } document ? document : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The receipt of an executed erasure: per module what was done, what was kept and why, the suppressions left.</summary>
    public static string Receipt(Document document, string manifestSha256) =>
        JsonSerializer.Serialize(new
        {
            @case = document.CaseNumber,
            manifest = document.ManifestId,
            manifestSha256,
            modules = document.Records.GroupBy(e => e.Record.Module).OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => new
            {
                module = g.Key,
                actions = g.GroupBy(e => e.Action).OrderBy(a => a.Key).Select(a => new { action = a.Key, records = a.Count() }).ToList(),
            }).ToList(),
            retained = document.Retained.Select(p => new
            {
                module = p.Record.Module,
                entityType = p.Record.EntityType,
                entityId = p.Record.EntityId,
                basis = p.Basis,
                until = p.RetainUntil,
                note = p.Note,
            }).ToList(),
            operatorErasure = document.Records.Where(e => e.Action == ErasureAction.OperatorErasure)
                .GroupBy(e => (e.Record.Module, e.Record.EntityType))
                .Select(g => new { module = g.Key.Module, entityType = g.Key.EntityType, records = g.Count() }).ToList(),
            suppressions = document.Suppressions.GroupBy(s => s.Kind).Select(g => new { kind = g.Key, count = g.Count() }).ToList(),
            externalSystems = document.Suppressions.Where(s => s.Kind == SuppressionKind.ExternalReference)
                .Select(s => s.Value.Split(':')[0]).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList(),
        }, PrivacyPlan.Json);
}
