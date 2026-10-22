using Crm.Security.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Security.Domain;

/// <summary>
/// A summary report of one customer's period (M41), read only: its period, a few figures and the source's link to the PDF. M43 files
/// the PDF among the customer's documents.
/// </summary>
public sealed class SummaryReport : Entity
{
    private SummaryReport() { }

    public string System { get; private set; } = string.Empty;
    public long ExternalId { get; private set; }
    public Guid OrganizationId { get; private set; }
    public long ExternalOrganizationId { get; private set; }

    /// <summary><c>monthly_summary</c>, <c>quarterly_summary</c> or <c>yearly_summary</c>.</summary>
    public string Type { get; private set; } = string.Empty;

    public DateOnly? PeriodStart { get; private set; }
    public DateOnly? PeriodEnd { get; private set; }
    public string? Url { get; private set; }
    public int? AgentsCount { get; private set; }
    public int? IncidentsReported { get; private set; }
    public int? IncidentsResolved { get; private set; }
    public long? SignalsDetected { get; private set; }
    public long? SignalsInvestigated { get; private set; }
    public long? EventsAnalyzed { get; private set; }
    public DateTimeOffset? CreatedAtSource { get; private set; }
    public DateTimeOffset ReadAt { get; private set; }

    public static SummaryReport From(ExternalReport source, DateTimeOffset now)
    {
        var report = new SummaryReport { System = source.System, ExternalId = source.ExternalId };
        report.Apply(source, now);
        return report;
    }

    /// <summary>The report as read now. Returns true when a field changed.</summary>
    public bool Apply(ExternalReport s, DateTimeOffset now)
    {
        var before = Signature();
        OrganizationId = s.OrganizationId;
        ExternalOrganizationId = s.ExternalOrganizationId;
        Type = Incident.Cut(s.Type, 32) ?? "monthly_summary";
        PeriodStart = s.PeriodStart;
        PeriodEnd = s.PeriodEnd;
        // Only an https link that fits is kept: anything else would lead somewhere else.
        Url = Uri.TryCreate(s.Url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && s.Url!.Length <= Incident.UrlLength ? s.Url : null;
        AgentsCount = s.AgentsCount;
        IncidentsReported = s.IncidentsReported;
        IncidentsResolved = s.IncidentsResolved;
        SignalsDetected = s.SignalsDetected;
        SignalsInvestigated = s.SignalsInvestigated;
        EventsAnalyzed = s.EventsAnalyzed;
        CreatedAtSource = s.CreatedAt;
        ReadAt = now;
        return before != Signature();
    }

    private string Signature() => string.Join('|', OrganizationId, ExternalOrganizationId, Type, PeriodStart, PeriodEnd, Url, AgentsCount, IncidentsReported,
        IncidentsResolved, SignalsDetected, SignalsInvestigated, EventsAnalyzed, Incident.Stamp(CreatedAtSource));
}

/// <summary>
/// What a security source counts for one of its organizations now (M41, Huntress's actual usage): agents it bills and among them
/// those it calls unresponsive, outdated or isolated, and the identities, learners and log sources it bills. One row per source
/// organization, replaced by every read; M43 compares it with the customer's contract.
/// </summary>
public sealed class ProductUsage : Entity
{
    private ProductUsage() { }

    public string System { get; private set; } = string.Empty;
    public long ExternalOrganizationId { get; private set; }
    public Guid OrganizationId { get; private set; }

    /// <summary>The organization's name at the source, so two source organizations of one customer can be told apart.</summary>
    public string Name { get; private set; } = string.Empty;

    public int? AgentsCount { get; private set; }
    public int? BillableAgents { get; private set; }
    public int? UnresponsiveAgents { get; private set; }
    public int? OutdatedAgents { get; private set; }
    public int? IsolatedAgents { get; private set; }
    public int? BillableIdentities { get; private set; }
    public int? SatLearners { get; private set; }
    public int? BillableLogSources { get; private set; }
    public DateTimeOffset ReadAt { get; private set; }

    public static ProductUsage From(ExternalUsage source, DateTimeOffset now)
    {
        var usage = new ProductUsage { System = source.System, ExternalOrganizationId = source.ExternalOrganizationId };
        usage.Apply(source, now);
        return usage;
    }

    /// <summary>The counts as read now. Returns true when one changed.</summary>
    public bool Apply(ExternalUsage s, DateTimeOffset now)
    {
        var before = (OrganizationId, Name, AgentsCount, BillableAgents, UnresponsiveAgents, OutdatedAgents, IsolatedAgents, BillableIdentities, SatLearners,
            BillableLogSources);
        OrganizationId = s.OrganizationId;
        Name = Incident.Cut(s.Name, 256) ?? string.Empty;
        AgentsCount = s.AgentsCount;
        BillableAgents = s.BillableAgents;
        UnresponsiveAgents = s.UnresponsiveAgents;
        OutdatedAgents = s.OutdatedAgents;
        IsolatedAgents = s.IsolatedAgents;
        BillableIdentities = s.BillableIdentities;
        SatLearners = s.SatLearners;
        BillableLogSources = s.BillableLogSources;
        ReadAt = now;
        return before != (OrganizationId, Name, AgentsCount, BillableAgents, UnresponsiveAgents, OutdatedAgents, IsolatedAgents, BillableIdentities, SatLearners,
            BillableLogSources);
    }
}
