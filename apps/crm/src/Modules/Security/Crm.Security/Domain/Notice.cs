using System.Globalization;
using System.Text.Json;
using Crm.Security.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Security.Domain;

/// <summary>
/// An escalation (the source asks the partner to decide something) or a platform action (something keeps the source from
/// protecting a customer), M41. Mirrored as read; the alert people work with is the Service module's.
/// </summary>
public sealed class Notice : Entity
{
    public const int SubjectLength = 512;
    public const int EntitiesLength = 4000;

    /// <summary>The source's statuses of a notice that still waits for the partner.</summary>
    public static readonly string[] OpenStatuses = ["open", "overdue"];

    private Notice() { }

    public string System { get; private set; } = string.Empty;
    public NoticeKind Kind { get; private set; }
    public long ExternalId { get; private set; }

    /// <summary>The CRM organization of its first linked source organization; null for a notice about the whole account.</summary>
    public Guid? OrganizationId { get; private set; }

    /// <summary>Every source organization it names, comma-separated.</summary>
    public string? ExternalOrganizationIds { get; private set; }

    public string Status { get; private set; } = string.Empty;
    public string Severity { get; private set; } = string.Empty;
    public string Subject { get; private set; } = string.Empty;
    public string? Type { get; private set; }

    /// <summary>The source's stable code of the kind (<c>unexpected_country_access</c>); the interface may branch on it.</summary>
    public string? TypeCode { get; private set; }

    public string? Subtype { get; private set; }

    /// <summary>
    /// What it is about as one JSON array of <c>{type, id, name}</c>: host names, and for an access escalation the identities, which are
    /// personal data of the customer's staff (retention class <c>security.closed-incidents</c>).
    /// </summary>
    public string? Entities { get; private set; }

    /// <summary>False when the source had more entities than it gave.</summary>
    public bool AllEntities { get; private set; } = true;

    public DateTimeOffset CreatedAtSource { get; private set; }
    public DateTimeOffset? ResolvedAtSource { get; private set; }
    public DateTimeOffset? UpdatedAtSource { get; private set; }
    public string? Url { get; private set; }
    public DateTimeOffset FirstReadAt { get; private set; }
    public DateTimeOffset ReadAt { get; private set; }

    /// <summary>When the entities were last read; null until a read by id gave them.</summary>
    public DateTimeOffset? EntitiesReadAt { get; private set; }

    public bool IsOpen => OpenStatuses.Contains(Status, StringComparer.Ordinal);

    public static Notice From(ExternalNotice source, DateTimeOffset now)
    {
        var notice = new Notice { System = source.System, Kind = source.Kind, ExternalId = source.ExternalId, FirstReadAt = now };
        notice.Apply(source, now);
        return notice;
    }

    /// <summary>The notice as read now; entities that were not read this time stay as stored. Returns true when a field changed.</summary>
    public bool Apply(ExternalNotice s, DateTimeOffset now)
    {
        var before = Signature();
        OrganizationId = s.OrganizationId;
        ExternalOrganizationIds = Incident.JoinWithin(s.ExternalOrganizationIds.Select(id => id.ToString(CultureInfo.InvariantCulture)), 256);
        Status = Incident.Cut(s.Status, 32)!;
        Severity = Incident.Cut(s.Severity, 16)!;
        Subject = Incident.Cut(s.Subject, SubjectLength)!;
        Type = Incident.Cut(s.Type, 128);
        TypeCode = Incident.Cut(s.TypeCode, 128);
        Subtype = Incident.Cut(s.Subtype, 128);
        if (s.Entities is { } entities)
        {
            Entities = WriteEntities(entities, out var fits);
            AllEntities = s.AllEntities && fits;
            EntitiesReadAt = now;
        }

        CreatedAtSource = s.CreatedAt;
        ResolvedAtSource = s.ResolvedAt;
        UpdatedAtSource = s.UpdatedAt;
        Url = s.Url is { Length: <= Incident.UrlLength } url ? url : null;
        ReadAt = now;
        return before != Signature();
    }

    /// <summary>The source no longer knows the notice: it stays as history, resolved now. Returns false when it was resolved already.</summary>
    public bool Gone(DateTimeOffset now)
    {
        if (!IsOpen)
        {
            return false;
        }

        Status = "resolved";
        ResolvedAtSource ??= now;
        ReadAt = now;
        return true;
    }

    /// <summary>The stored entities; none when they were never read or cannot be read.</summary>
    public IReadOnlyList<NoticeEntity> ReadEntities()
    {
        if (string.IsNullOrEmpty(Entities))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<List<NoticeEntity>>(Entities, JsonOptions) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public NoticeView ToView() => new(
        Id, System, Kind, ExternalId, OrganizationId,
        ExternalOrganizationIds?.Split(',') is [var first, ..] && long.TryParse(first, CultureInfo.InvariantCulture, out var id) ? id : null,
        Status, Severity, Subject, TypeCode, IsOpen, Url, UpdatedAtSource, EntitiesReadAt, ReadEntities());

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>As many whole entities as fit the column, in the source's order.</summary>
    private static string? WriteEntities(IReadOnlyList<NoticeEntity> entities, out bool fits)
    {
        fits = true;
        var kept = new List<NoticeEntity>();
        foreach (var entity in entities)
        {
            var trial = JsonSerializer.Serialize(kept.Append(entity).ToList(), JsonOptions);
            if (trial.Length > EntitiesLength)
            {
                fits = false;
                break;
            }

            kept.Add(entity);
        }

        return kept.Count == 0 ? null : JsonSerializer.Serialize(kept, JsonOptions);
    }

    private string Signature() => string.Join('|', OrganizationId, ExternalOrganizationIds, Status, Severity, Subject, Type, TypeCode, Subtype, Entities,
        AllEntities, Incident.Stamp(CreatedAtSource), Incident.Stamp(ResolvedAtSource), Incident.Stamp(UpdatedAtSource), Url);
}
