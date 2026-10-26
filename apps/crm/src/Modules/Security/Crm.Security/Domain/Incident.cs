using System.Globalization;
using System.Text.Json;
using Crm.Security.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Security.Domain;

/// <summary>
/// An incident report of a security source (Huntress, M41), mirrored with its remediation plan and its comments. Not audited: the
/// source is the system of record, and what people ask of it is kept with the action that asked. The alert people work with is
/// the Service module's; this is the detail behind it (summary, indicators, plan, comments).
/// </summary>
public sealed class Incident : Entity
{
    public const int SubjectLength = 512;
    public const int SummaryLength = 4000;
    public const int BodyLength = 16000;
    public const int DeviceNameLength = 256;
    public const int UrlLength = 512;
    public const int IndicatorTypesLength = 512;
    public const int IndicatorCountsLength = 1024;

    /// <summary>The source's statuses of an incident that still waits for someone: the partner, its automation or the SOC.</summary>
    public static readonly string[] OpenStatuses = ["sent", "auto_remediating", "draft"];

    /// <summary>The status of an incident the source no longer knows (deleted there).</summary>
    public const string Deleted = "deleted";

    private readonly List<Remediation> _remediations = [];
    private readonly List<IncidentComment> _comments = [];

    private Incident() { }

    public string System { get; private set; } = string.Empty;
    public long ExternalId { get; private set; }
    public Guid OrganizationId { get; private set; }

    /// <summary>The source's organization the incident was read under.</summary>
    public long ExternalOrganizationId { get; private set; }

    /// <summary>The source's id of the agent the incident is about; the Service module's device of that agent shows the machine.</summary>
    public string? AgentExternalId { get; private set; }

    public string? DeviceName { get; private set; }
    public string Status { get; private set; } = string.Empty;
    public string Severity { get; private set; } = string.Empty;
    public string Subject { get; private set; } = string.Empty;

    /// <summary>What the SOC analyst wrote: may name people of the customer (retention class <c>security.closed-incidents</c>).</summary>
    public string? Summary { get; private set; }

    /// <summary>The source's generated detail of the incident; the same personal data as the summary.</summary>
    public string? Body { get; private set; }

    public string? Platform { get; private set; }

    /// <summary>The kinds of indicator found, comma-separated (<c>footholds,process_detections</c>).</summary>
    public string? IndicatorTypes { get; private set; }

    /// <summary>The count per kind of indicator as one JSON object, names in order.</summary>
    public string? IndicatorCounts { get; private set; }

    public DateTimeOffset? SentAt { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }
    public DateTimeOffset? StatusUpdatedAt { get; private set; }
    public DateTimeOffset? UpdatedAtSource { get; private set; }
    public string? Url { get; private set; }
    public DateTimeOffset FirstReadAt { get; private set; }

    /// <summary>When a read last found the incident; a refreshed read time alone is not a change.</summary>
    public DateTimeOffset ReadAt { get; private set; }

    public DateTimeOffset? RemediationsReadAt { get; private set; }
    public DateTimeOffset? CommentsReadAt { get; private set; }

    public IReadOnlyList<Remediation> Remediations => _remediations;
    public IReadOnlyList<IncidentComment> Comments => _comments;

    public bool IsOpen => OpenStatuses.Contains(Status, StringComparer.Ordinal);

    public static Incident From(ExternalIncident source, DateTimeOffset now)
    {
        var incident = new Incident { System = source.System, ExternalId = source.ExternalId, FirstReadAt = now };
        incident.Apply(source, now);
        return incident;
    }

    /// <summary>The report as read now. Returns true when a field changed.</summary>
    public bool Apply(ExternalIncident s, DateTimeOffset now)
    {
        var before = Signature();
        OrganizationId = s.OrganizationId;
        ExternalOrganizationId = s.ExternalOrganizationId;
        AgentExternalId = Cut(s.AgentExternalId, 64);
        DeviceName = Cut(s.DeviceName, DeviceNameLength);
        Status = Cut(s.Status, 32)!;
        Severity = Cut(s.Severity, 16)!;
        Subject = Cut(s.Subject, SubjectLength)!;
        Summary = Cut(s.Summary, SummaryLength);
        Body = Cut(s.Body, BodyLength);
        Platform = Cut(s.Platform, 32);
        IndicatorTypes = JoinWithin(s.IndicatorTypes, IndicatorTypesLength);
        IndicatorCounts = s.IndicatorCounts.Count == 0 ? null
            : JsonSerializer.Serialize(new SortedDictionary<string, int>(s.IndicatorCounts.ToDictionary(), StringComparer.Ordinal)) is { Length: <= IndicatorCountsLength } json ? json : null;
        SentAt = s.SentAt;
        ClosedAt = s.ClosedAt;
        StatusUpdatedAt = s.StatusUpdatedAt;
        UpdatedAtSource = s.UpdatedAt;
        // A link that does not fit is left out rather than cut into an address that leads somewhere else.
        Url = s.Url is { Length: <= UrlLength } url ? url : null;
        ReadAt = now;
        return before != Signature();
    }

    /// <summary>The plan as the source has it now: steps it no longer lists go, new ones come, the others follow it.</summary>
    public bool ApplyRemediations(IReadOnlyCollection<ExternalRemediation> remediations, DateTimeOffset now)
    {
        RemediationsReadAt = now;
        var changed = false;
        var listed = remediations.DistinctBy(r => r.ExternalId).ToDictionary(r => r.ExternalId);
        foreach (var gone in _remediations.Where(r => !listed.ContainsKey(r.ExternalId)).ToList())
        {
            _remediations.Remove(gone);
            changed = true;
        }

        foreach (var source in listed.Values)
        {
            if (_remediations.FirstOrDefault(r => r.ExternalId == source.ExternalId) is { } stored)
            {
                changed |= stored.Apply(source);
            }
            else
            {
                _remediations.Add(Remediation.From(Id, source));
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>The comments as the source has them now: one it no longer lists was deleted there and goes here too.</summary>
    public bool ApplyComments(IReadOnlyCollection<ExternalIncidentComment> comments, DateTimeOffset now)
    {
        CommentsReadAt = now;
        var changed = false;
        var listed = comments.DistinctBy(c => c.ExternalId).ToDictionary(c => c.ExternalId);
        foreach (var gone in _comments.Where(c => !listed.ContainsKey(c.ExternalId)).ToList())
        {
            _comments.Remove(gone);
            changed = true;
        }

        foreach (var source in listed.Values)
        {
            if (_comments.FirstOrDefault(c => c.ExternalId == source.ExternalId) is { } stored)
            {
                changed |= stored.Apply(source);
            }
            else
            {
                _comments.Add(IncidentComment.From(Id, source));
                changed = true;
            }
        }

        return changed;
    }

    /// <summary>The source no longer knows the incident: it stays as history, closed now. Returns false when it was closed already.</summary>
    public bool Gone(DateTimeOffset now)
    {
        if (Status == Deleted)
        {
            return false;
        }

        Status = Deleted;
        ClosedAt ??= now;
        ReadAt = now;
        return true;
    }

    public IncidentView ToView() => new(
        Id, System, ExternalId, OrganizationId, ExternalOrganizationId, AgentExternalId, DeviceName, Status, Severity, Subject, IsOpen, Url,
        UpdatedAtSource, CommentsReadAt,
        _remediations.OrderBy(r => r.ExternalId).Select(r => new RemediationView(r.ExternalId, r.Type, r.Action, r.Status, r.CompletedAt)).ToList());

    internal static string? Cut(string? value, int length) => value?.Trim() is { Length: > 0 } text ? text.Length > length ? text[..length] : text : null;

    /// <summary>The distinct values, comma-separated, as many whole ones as fit.</summary>
    internal static string? JoinWithin(IEnumerable<string> values, int length)
    {
        var kept = new List<string>();
        var used = 0;
        foreach (var value in values.Select(v => v.Trim()).Where(v => v.Length > 0 && !v.Contains(',')).Distinct(StringComparer.Ordinal))
        {
            var needed = value.Length + (kept.Count > 0 ? 1 : 0);
            if (used + needed > length)
            {
                break;
            }

            kept.Add(value);
            used += needed;
        }

        return kept.Count == 0 ? null : string.Join(',', kept);
    }

    private string Signature() => string.Join('|', OrganizationId, ExternalOrganizationId, AgentExternalId, DeviceName, Status, Severity, Subject, Summary, Body,
        Platform, IndicatorTypes, IndicatorCounts, Stamp(SentAt), Stamp(ClosedAt), Stamp(StatusUpdatedAt), Stamp(UpdatedAtSource), Url);

    internal static string? Stamp(DateTimeOffset? value) => value?.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);
}

/// <summary>One step of an incident's remediation plan (M41), as the source has it.</summary>
public sealed class Remediation : Entity
{
    public const int ActionLength = 512;
    public const int ParametersLength = 4000;

    private Remediation() { }

    public Guid IncidentId { get; private set; }
    public long ExternalId { get; private set; }

    /// <summary><c>assisted</c> (the source carries it out once approved), <c>manual</c> (a person does it) or <c>containment</c>.</summary>
    public string Type { get; private set; } = string.Empty;

    public string? Action { get; private set; }

    /// <summary>The step's detail as the source wrote it (paths, keys, accounts): personal data like the incident's texts.</summary>
    public string? Parameters { get; private set; }

    /// <summary><c>unapproved</c>, <c>approved</c>, <c>completed</c>, <c>failed</c> or <c>cancelled</c>.</summary>
    public string Status { get; private set; } = string.Empty;

    public DateTimeOffset? ApprovedAt { get; private set; }

    /// <summary>Who approved it at the source, by name.</summary>
    public string? ApprovedBy { get; private set; }

    public DateTimeOffset? CompletedAt { get; private set; }

    internal static Remediation From(Guid incidentId, ExternalRemediation source)
    {
        var remediation = new Remediation { IncidentId = incidentId, ExternalId = source.ExternalId };
        remediation.Apply(source);
        return remediation;
    }

    internal bool Apply(ExternalRemediation s)
    {
        var before = (Type, Action, Parameters, Status, Incident.Stamp(ApprovedAt), ApprovedBy, Incident.Stamp(CompletedAt));
        Type = Incident.Cut(s.Type, 32) ?? "manual";
        Action = Incident.Cut(s.Action, ActionLength);
        // Detail that does not fit is left out rather than cut into a path or a command that says something else.
        Parameters = s.Parameters is { Length: <= ParametersLength } parameters ? parameters : null;
        Status = Incident.Cut(s.Status, 32) ?? "unapproved";
        ApprovedAt = s.ApprovedAt;
        ApprovedBy = Incident.Cut(s.ApprovedBy, 256);
        CompletedAt = s.CompletedAt;
        return before != (Type, Action, Parameters, Status, Incident.Stamp(ApprovedAt), ApprovedBy, Incident.Stamp(CompletedAt));
    }
}

/// <summary>One comment of an incident (M41): people of the partner, or the source's SOC.</summary>
public sealed class IncidentComment : Entity
{
    public const int BodyLength = 4000;

    private IncidentComment() { }

    public Guid IncidentId { get; private set; }
    public long ExternalId { get; private set; }
    public string Body { get; private set; } = string.Empty;
    public string? Author { get; private set; }
    public DateTimeOffset CreatedAtSource { get; private set; }
    public DateTimeOffset? UpdatedAtSource { get; private set; }

    internal static IncidentComment From(Guid incidentId, ExternalIncidentComment source)
    {
        var comment = new IncidentComment { IncidentId = incidentId, ExternalId = source.ExternalId };
        comment.Apply(source);
        return comment;
    }

    internal bool Apply(ExternalIncidentComment s)
    {
        var before = (Body, Author, Incident.Stamp(CreatedAtSource), Incident.Stamp(UpdatedAtSource));
        Body = s.Body.Length > BodyLength ? s.Body[..BodyLength] : s.Body;
        Author = Incident.Cut(s.Author, 256);
        CreatedAtSource = s.CreatedAt;
        UpdatedAtSource = s.UpdatedAt;
        return before != (Body, Author, Incident.Stamp(CreatedAtSource), Incident.Stamp(UpdatedAtSource));
    }
}
