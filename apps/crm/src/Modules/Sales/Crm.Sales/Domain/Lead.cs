using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Sales.Domain;

public sealed record LeadDetails(
    string CompanyName,
    string? OrgNumber,
    string? ContactName,
    string? Email,
    string? Phone,
    string? Source,
    Guid? OwnerId,
    string? Notes);

/// <summary>An unqualified enquiry. Converting it creates the organization, its first contact and, optionally, an opportunity (FR-SAL-01).</summary>
public sealed class Lead : AuditableEntity, IErasable
{
    private Lead() { }

    public string CompanyName { get; private set; } = string.Empty;
    public string? OrgNumber { get; private set; }
    public string? ContactName { get; private set; }
    public string? Email { get; private set; }
    public string? Phone { get; private set; }
    public string? Source { get; private set; }
    public LeadStatus Status { get; private set; }
    public Guid? OwnerId { get; private set; }
    public string? Notes { get; private set; }
    public string? DisqualifyReason { get; private set; }
    public Guid? OrganizationId { get; private set; }
    public Guid? OpportunityId { get; private set; }
    public DateTimeOffset? ClosedAt { get; private set; }

    /// <inheritdoc />
    public string? ErasureReference { get; private set; }

    /// <summary>
    /// Erases the prospect's details under a privacy case or a retention policy (DEV-11): name, address, phone and the free
    /// text about them go, the company and the lead's history stay, and the lead leaves every list. Converted or not.
    /// </summary>
    public bool Pseudonymize(string reference)
    {
        if (ContactName is null && Email is null && Phone is null && Notes is null && DisqualifyReason is null && IsDeleted)
        {
            return false;
        }

        ErasureReference = reference;
        ContactName = null;
        Email = null;
        Phone = null;
        Notes = null;
        DisqualifyReason = null;
        MarkDeleted();
        return true;
    }

    public static Result<Lead> Create(LeadDetails details)
    {
        var lead = new Lead { Status = LeadStatus.New };
        var applied = lead.Apply(details);
        return applied.IsSuccess ? lead : applied.Error!;
    }

    public Result Update(LeadDetails details) =>
        Status is LeadStatus.Converted
            ? Error.Conflict("SAL_LEAD_CONVERTED", "The lead is already converted; edit the organization instead.")
            : Apply(details);

    public Result Qualify()
    {
        if (Status is not (LeadStatus.New or LeadStatus.Disqualified))
        {
            return Error.Conflict("SAL_LEAD_STATUS", $"A {Status} lead cannot be qualified.");
        }

        Status = LeadStatus.Qualified;
        DisqualifyReason = null;
        ClosedAt = null;
        return Result.Success();
    }

    public Result Disqualify(string reason, DateTimeOffset at)
    {
        if (Status == LeadStatus.Converted)
        {
            return Error.Conflict("SAL_LEAD_CONVERTED", "The lead is already converted.");
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            return Error.Validation("SAL_REASON_REQUIRED", "Say why the lead is disqualified.");
        }

        Status = LeadStatus.Disqualified;
        DisqualifyReason = reason.Trim();
        ClosedAt = at;
        return Result.Success();
    }

    public Result Convert(Guid organizationId, Guid? opportunityId, DateTimeOffset at)
    {
        if (Status == LeadStatus.Converted)
        {
            return Error.Conflict("SAL_LEAD_CONVERTED", "The lead is already converted.");
        }

        Status = LeadStatus.Converted;
        OrganizationId = organizationId;
        OpportunityId = opportunityId;
        ClosedAt = at;
        Raise(new LeadConverted(Id, organizationId, opportunityId));
        return Result.Success();
    }

    private Result Apply(LeadDetails d)
    {
        if (string.IsNullOrWhiteSpace(d.CompanyName))
        {
            return Error.Validation("SAL_LEAD_NAME_REQUIRED", "The lead needs a company name.");
        }

        CompanyName = d.CompanyName.Trim();
        OrgNumber = Clean(d.OrgNumber);
        ContactName = Clean(d.ContactName);
        Email = Clean(d.Email)?.ToLowerInvariant();
        Phone = Clean(d.Phone);
        Source = Clean(d.Source);
        OwnerId = d.OwnerId;
        Notes = Clean(d.Notes);
        return Result.Success();
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
