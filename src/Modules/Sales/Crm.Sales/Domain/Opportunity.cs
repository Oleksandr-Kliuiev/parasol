using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Sales.Domain;

public sealed record OpportunityDetails(
    Guid OrganizationId,
    Guid? ContactId,
    string Name,
    BusinessLine BusinessLine,
    Guid StageId,
    int? Probability,
    DateOnly ExpectedCloseDate,
    decimal OneOffAmount,
    decimal Mrr,
    int TermMonths,
    Guid? OwnerId,
    string? Source,
    string? Competitor);

public sealed class Opportunity : AuditableEntity
{
    /// <summary>An opportunity nobody touched for this long is stale (BR-SAL-03).</summary>
    public const int StaleAfterDays = 30;

    private Opportunity() { }

    public Guid OrganizationId { get; private set; }
    public Guid? ContactId { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public BusinessLine BusinessLine { get; private set; }
    public Guid StageId { get; private set; }
    public int Probability { get; private set; }
    public DateOnly ExpectedCloseDate { get; private set; }
    public decimal OneOffAmount { get; private set; }

    /// <summary>Monthly recurring revenue the deal adds.</summary>
    public decimal Mrr { get; private set; }

    public int TermMonths { get; private set; }
    public Guid? OwnerId { get; private set; }
    public string? Source { get; private set; }
    public string? Competitor { get; private set; }
    public OpportunityStatus Status { get; private set; }
    public string? LostReason { get; private set; }
    public DateOnly? ClosedOn { get; private set; }

    /// <summary>Last activity (call, meeting, note, task) logged against the deal; drives the stale warning.</summary>
    public DateTimeOffset LastActivityAt { get; private set; }

    public static Result<Opportunity> Create(OpportunityDetails details, int stageProbability, DateTimeOffset now)
    {
        var opportunity = new Opportunity { Status = OpportunityStatus.Open, LastActivityAt = now };
        var applied = opportunity.Apply(details, stageProbability);
        return applied.IsSuccess ? opportunity : applied.Error!;
    }

    public Result Update(OpportunityDetails details, int stageProbability)
    {
        if (Status != OpportunityStatus.Open)
        {
            return Error.Conflict("SAL_OPPORTUNITY_CLOSED", "Reopen the deal before changing it.");
        }

        return Apply(details, stageProbability);
    }

    /// <summary>Moves the deal to another stage; the stage's probability applies unless it was set by hand.</summary>
    public Result MoveTo(Guid stageId, int stageProbability, bool isWon, bool isLost, string? lostReason, DateOnly today, DateTimeOffset now)
    {
        if (Status != OpportunityStatus.Open)
        {
            return Error.Conflict("SAL_OPPORTUNITY_CLOSED", "Reopen the deal first.");
        }

        if (isLost && string.IsNullOrWhiteSpace(lostReason))
        {
            return Error.Validation("SAL_LOST_REASON_REQUIRED", "Choose why the deal was lost (BR-SAL-02).");
        }

        StageId = stageId;
        Probability = stageProbability;
        LastActivityAt = now;
        if (isWon)
        {
            Status = OpportunityStatus.Won;
            Probability = 100;
            ClosedOn = today;
            LostReason = null;
            Raise(new OpportunityWon(Id, OrganizationId, OneOffAmount, Mrr));
        }
        else if (isLost)
        {
            Status = OpportunityStatus.Lost;
            Probability = 0;
            ClosedOn = today;
            LostReason = lostReason!.Trim();
            Raise(new OpportunityLost(Id, OrganizationId, LostReason));
        }

        return Result.Success();
    }

    public Result Reopen(Guid stageId, int stageProbability, DateTimeOffset now)
    {
        if (Status == OpportunityStatus.Open)
        {
            return Error.Conflict("SAL_OPPORTUNITY_OPEN", "The deal is already open.");
        }

        Status = OpportunityStatus.Open;
        StageId = stageId;
        Probability = stageProbability;
        ClosedOn = null;
        LostReason = null;
        LastActivityAt = now;
        return Result.Success();
    }

    public void RecordActivity(DateTimeOffset at)
    {
        if (at > LastActivityAt)
        {
            LastActivityAt = at;
        }
    }

    public void MoveToOrganization(Guid targetOrganizationId) => OrganizationId = targetOrganizationId;

    /// <summary>BR-SAL-01: expected revenue = one-off × probability + MRR × min(term, 12) × probability.</summary>
    public decimal ForecastAmount => Forecast(OneOffAmount, Mrr, TermMonths, Probability);

    public static decimal Forecast(decimal oneOff, decimal mrr, int termMonths, int probability) =>
        decimal.Round((oneOff + (mrr * Math.Min(Math.Max(termMonths, 0), 12))) * probability / 100m, 2);

    public bool IsStale(DateTimeOffset now) => Status == OpportunityStatus.Open && (now - LastActivityAt).TotalDays > StaleAfterDays;

    private Result Apply(OpportunityDetails d, int stageProbability)
    {
        if (string.IsNullOrWhiteSpace(d.Name))
        {
            return Error.Validation("SAL_OPPORTUNITY_NAME_REQUIRED", "The deal needs a name.");
        }

        if (d.Probability is < 0 or > 100)
        {
            return Error.Validation("SAL_PROBABILITY", "Probability must be between 0 and 100 %.");
        }

        if (d.OneOffAmount < 0 || d.Mrr < 0 || d.TermMonths < 0)
        {
            return Error.Validation("SAL_AMOUNTS", "Amounts and the term cannot be negative.");
        }

        OrganizationId = d.OrganizationId;
        ContactId = d.ContactId;
        Name = d.Name.Trim();
        BusinessLine = d.BusinessLine;
        StageId = d.StageId;
        Probability = d.Probability ?? stageProbability;
        ExpectedCloseDate = d.ExpectedCloseDate;
        OneOffAmount = decimal.Round(d.OneOffAmount, 2);
        Mrr = decimal.Round(d.Mrr, 2);
        TermMonths = d.TermMonths;
        OwnerId = d.OwnerId;
        Source = Clean(d.Source);
        Competitor = Clean(d.Competitor);
        return Result.Success();
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
