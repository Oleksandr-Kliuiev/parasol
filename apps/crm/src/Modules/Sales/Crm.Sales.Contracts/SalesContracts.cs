using Crm.SharedKernel.Domain;

namespace Crm.Sales.Contracts;

public enum LeadStatus
{
    New,
    Qualified,
    Disqualified,
    Converted,
}

/// <summary>Which part of the business a deal is about (docs/02 §4.3).</summary>
public enum BusinessLine
{
    Microsoft,
    Msp,
    PowerOffice,
    Mixed,
}

public enum OpportunityStatus
{
    Open,
    Won,
    Lost,
}

public sealed record OpportunityRef(Guid Id, string Name, Guid OrganizationId, OpportunityStatus Status);

/// <summary>Pipeline figures for the dashboard (FR-RPT-01); amounts are excluding VAT.</summary>
public sealed record PipelineSummary(
    int Open, decimal WeightedForecast, decimal OpenValue, int Stale, int WonLast90Days, decimal WonAmountLast90Days, int LostLast90Days);

/// <summary>An open deal nobody has touched for a while (BR-SAL-03).</summary>
public sealed record StaleOpportunity(Guid OpportunityId, string Name, Guid OrganizationId, Guid? OwnerId, DateTimeOffset LastActivityAt, int DaysQuiet);

/// <summary>Public API of the Sales module for other modules.</summary>
public interface ISalesApi
{
    Task<IReadOnlyDictionary<Guid, OpportunityRef>> GetOpportunitiesAsync(IReadOnlyCollection<Guid> opportunityIds, CancellationToken cancellationToken);

    /// <summary>Open opportunities of an organization, newest first.</summary>
    Task<IReadOnlyList<OpportunityRef>> GetOpenOpportunitiesAsync(Guid organizationId, CancellationToken cancellationToken);

    Task<PipelineSummary> GetPipelineSummaryAsync(DateTimeOffset now, CancellationToken cancellationToken);

    /// <summary>Open deals without activity for longer than the stale threshold, quietest first.</summary>
    Task<IReadOnlyList<StaleOpportunity>> GetStaleOpportunitiesAsync(DateTimeOffset now, CancellationToken cancellationToken);
}

public sealed record LeadConverted(Guid LeadId, Guid OrganizationId, Guid? OpportunityId) : DomainEvent;

public sealed record OpportunityWon(Guid OpportunityId, Guid OrganizationId, decimal OneOffAmount, decimal Mrr) : DomainEvent;

public sealed record OpportunityLost(Guid OpportunityId, Guid OrganizationId, string Reason) : DomainEvent;

/// <summary>A quote line is invoiced once or every month; the split decides what an accepted quote turns into (BR-SAL-07).</summary>
public enum QuoteLineRecurrence
{
    OneTime,
    Monthly,
}

public sealed record AcceptedQuoteLine(
    Guid LineId,
    Guid? ProductId,
    string Name,
    string? Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountPct,
    decimal VatRate,
    QuoteLineRecurrence Recurrence);

/// <summary>
/// A customer accepted a quote (BR-SAL-07). Contracts turns the monthly lines into a draft contract and Billing queues the
/// one-time lines for the next run; both handlers are keyed by the quote so a repeated delivery changes nothing.
/// </summary>
public sealed record QuoteAccepted(
    Guid QuoteId,
    string Number,
    int VersionNo,
    Guid OrganizationId,
    Guid? OpportunityId,
    Guid? OwnerId,
    string Title,
    DateOnly AcceptedOn,
    int TermMonths,
    IReadOnlyList<AcceptedQuoteLine> Lines) : DomainEvent;

/// <summary>A quote ready to leave the house, as the sender's own mailbox will show it (FR-SAL-04).</summary>
public sealed record QuoteMail(
    string SenderAddress,
    string ToAddress,
    string? ToName,
    IReadOnlyList<string> Cc,
    string Subject,
    string HtmlBody,
    string FileName,
    ReadOnlyMemory<byte> Pdf);

/// <summary>Sends a quote from the salesperson's own mailbox; implemented by the Microsoft Graph integration.</summary>
public interface IQuoteMailSender
{
    bool IsConfigured { get; }

    Task SendAsync(QuoteMail mail, CancellationToken cancellationToken);
}
