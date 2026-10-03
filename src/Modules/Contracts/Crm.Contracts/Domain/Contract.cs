using Crm.Contracts.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Contracts.Domain;

public sealed record ContractTerms(
    string Title,
    ContractType Type,
    DateOnly StartDate,
    DateOnly? EndDate,
    bool AutoRenew,
    int RenewalTermMonths,
    int NoticePeriodDays,
    Guid? SlaPolicyId,
    InvoiceFrequency InvoiceFrequency,
    InvoiceTiming InvoiceTiming,
    string? PriceCategory,
    bool Indexation,
    DateOnly? NextIndexationDate,
    string? CustomerReference,
    Guid? OwnerId,
    string? Notes);

/// <summary>What one contract line's price became when the contract was indexed (BR-CON-06).</summary>
public sealed record IndexedLine(Guid SeriesId, Guid ProductId, string? Description, decimal Quantity, decimal PriceBefore, decimal PriceAfter);

public sealed record LineTerms(
    Guid ProductId,
    string? Description,
    QuantityModel QuantityModel,
    DeviceFilter DeviceFilter,
    decimal Quantity,
    decimal? UnitPrice,
    decimal DiscountPct,
    DateOnly ValidFrom,
    DateOnly? ValidTo);

internal static class ContractErrors
{
    public static Error InvalidTransition(ContractStatus from, string action) =>
        Error.Conflict("CON_INVALID_STATUS", $"A contract in status {from} cannot be {action}.", new Dictionary<string, object?> { ["status"] = from.ToString() });

    public static Error InvalidPeriod => Error.Validation("CON_INVALID_PERIOD", "The end date must be on or after the start date.");

    public static Error NoticeTooShort(DateOnly earliest) => Error.Validation(
        "CON_NOTICE_TOO_SHORT", $"With the notice period the contract can end on {earliest:yyyy-MM-dd} at the earliest.",
        new Dictionary<string, object?> { ["earliestEndDate"] = earliest.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture) });

    public static Error LineNotFound(Guid id) => Error.NotFound("CON_LINE_NOT_FOUND", $"Contract line {id} was not found.");

    public static Error LineOutsideContract => Error.Validation("CON_LINE_OUTSIDE_CONTRACT", "The line period must lie within the contract period.");

    public static Error RevisionDate => Error.Validation("CON_REVISION_DATE", "The change must take effect after the line's start date and before its end date.");

    public static Error OnlyDraftCanBeDeleted => Error.Conflict("CON_NOT_DRAFT", "Only draft contracts can be deleted; end the contract instead.");
}

public sealed class Contract : AuditableEntity
{
    private readonly List<ContractLine> _lines = [];

    private Contract() { }

    public string Number { get; private set; } = string.Empty;
    public Guid OrganizationId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public ContractType Type { get; private set; }
    public ContractStatus Status { get; private set; }
    public DateOnly StartDate { get; private set; }
    public DateOnly? EndDate { get; private set; }
    public bool AutoRenew { get; private set; }
    public int RenewalTermMonths { get; private set; }
    public int NoticePeriodDays { get; private set; }
    public Guid? SlaPolicyId { get; private set; }
    public InvoiceFrequency InvoiceFrequency { get; private set; }
    public InvoiceTiming InvoiceTiming { get; private set; }
    public string? PriceCategory { get; private set; }
    public bool Indexation { get; private set; }
    public DateOnly? NextIndexationDate { get; private set; }
    public string? CustomerReference { get; private set; }
    public Guid? OwnerId { get; private set; }
    public string? Notes { get; private set; }
    public DateOnly? NoticeGivenOn { get; private set; }

    /// <summary>End date before notice was given, restored when the notice is withdrawn.</summary>
    public DateOnly? EndDateBeforeNotice { get; private set; }

    public DateOnly? EndedOn { get; private set; }
    public int RenewalCount { get; private set; }

    /// <summary>The quote this contract was drafted from (BR-SAL-07); it also keeps a repeated event from drafting it twice.</summary>
    public Guid? SourceQuoteId { get; private set; }

    /// <summary>Set when the contract was moved by an organization merge, so an undo can move it back.</summary>
    public Guid? MovedByMergeId { get; private set; }

    public Guid? PreviousOrganizationId { get; private set; }

    public IReadOnlyList<ContractLine> Lines => _lines;

    public bool IsLive => Status is ContractStatus.Active or ContractStatus.Suspended or ContractStatus.NoticeGiven;

    public static Result<Contract> Create(string number, Guid organizationId, ContractTerms terms)
    {
        var contract = new Contract { Number = number, OrganizationId = organizationId, Status = ContractStatus.Draft };
        var applied = contract.Apply(terms);
        return applied.IsSuccess ? contract : applied.Error!;
    }

    public Result Update(Guid organizationId, ContractTerms terms)
    {
        if (Status == ContractStatus.Ended)
        {
            return ContractErrors.InvalidTransition(Status, "edited");
        }

        if (Status == ContractStatus.NoticeGiven && terms.EndDate != EndDate)
        {
            return Error.Conflict("CON_NOTICE_GIVEN", "Withdraw the notice before changing the end date.");
        }

        // The customer of a running contract never changes; only drafts can be re-pointed.
        if (Status == ContractStatus.Draft)
        {
            OrganizationId = organizationId;
        }

        var slaBefore = SlaPolicyId;
        var applied = Apply(terms);
        if (applied.IsSuccess && IsLive && slaBefore != SlaPolicyId)
        {
            Raise(new OrganizationSlaChanged(OrganizationId));
        }

        return applied;
    }

    public Result Activate()
    {
        if (Status is not (ContractStatus.Draft or ContractStatus.Suspended))
        {
            return ContractErrors.InvalidTransition(Status, "activated");
        }

        var wasDraft = Status == ContractStatus.Draft;
        Status = ContractStatus.Active;
        if (wasDraft)
        {
            Raise(new ContractActivated(Id, OrganizationId));
        }

        Raise(new OrganizationSlaChanged(OrganizationId));
        return Result.Success();
    }

    public Result Suspend()
    {
        if (Status != ContractStatus.Active)
        {
            return ContractErrors.InvalidTransition(Status, "suspended");
        }

        Status = ContractStatus.Suspended;
        Raise(new OrganizationSlaChanged(OrganizationId));
        return Result.Success();
    }

    /// <summary>Customer or company gives notice: the contract ends on <paramref name="endDate"/>, no earlier than the notice period allows.</summary>
    public Result GiveNotice(DateOnly noticeDate, DateOnly endDate)
    {
        if (Status is not (ContractStatus.Active or ContractStatus.Suspended))
        {
            return ContractErrors.InvalidTransition(Status, "given notice");
        }

        var earliest = noticeDate.AddDays(NoticePeriodDays);
        if (endDate < earliest)
        {
            return ContractErrors.NoticeTooShort(earliest);
        }

        if (endDate < StartDate)
        {
            return ContractErrors.InvalidPeriod;
        }

        EndDateBeforeNotice = EndDate;
        EndDate = endDate;
        NoticeGivenOn = noticeDate;
        Status = ContractStatus.NoticeGiven;
        return Result.Success();
    }

    public Result WithdrawNotice()
    {
        if (Status != ContractStatus.NoticeGiven)
        {
            return ContractErrors.InvalidTransition(Status, "withdrawn from notice");
        }

        EndDate = EndDateBeforeNotice;
        EndDateBeforeNotice = null;
        NoticeGivenOn = null;
        Status = ContractStatus.Active;
        return Result.Success();
    }

    public Result End(DateOnly endedOn)
    {
        if (!IsLive)
        {
            return ContractErrors.InvalidTransition(Status, "ended");
        }

        if (endedOn < StartDate)
        {
            return ContractErrors.InvalidPeriod;
        }

        Status = ContractStatus.Ended;
        EndedOn = endedOn;
        EndDate = EndDate is { } end && end < endedOn ? end : endedOn;
        foreach (var line in _lines.Where(l => l.ValidTo is null || l.ValidTo > EndDate))
        {
            line.EndOn(EndDate.Value < line.ValidFrom ? line.ValidFrom : EndDate.Value);
        }

        Raise(new ContractEnded(Id, OrganizationId));
        Raise(new OrganizationSlaChanged(OrganizationId));
        return Result.Success();
    }

    /// <summary>
    /// Daily rule at the end date (BR-CON-04): a contract under notice or without automatic renewal ends; otherwise it is renewed by the
    /// renewal term until the end date is in the future. Returns true when anything changed.
    /// </summary>
    public bool ApplyEndOfTerm(DateOnly today)
    {
        if (!IsLive || EndDate is not { } end || end >= today)
        {
            return false;
        }

        if (Status == ContractStatus.NoticeGiven || !AutoRenew || RenewalTermMonths <= 0)
        {
            End(end);
            return true;
        }

        while (EndDate < today)
        {
            EndDate = EndDate.Value.AddMonths(RenewalTermMonths);
            RenewalCount++;
        }

        Raise(new ContractRenewed(Id, OrganizationId, EndDate.Value));
        return true;
    }

    public Result<ContractLine> AddLine(LineTerms terms)
    {
        if (Status == ContractStatus.Ended)
        {
            return ContractErrors.InvalidTransition(Status, "changed");
        }

        if (CheckLinePeriod(terms.ValidFrom, terms.ValidTo) is { } error)
        {
            return error;
        }

        var line = ContractLine.Create(Id, terms);
        _lines.Add(line);
        return line;
    }

    /// <summary>
    /// Draft: the line is edited in place. Running contract: price, discount or quantity changes create a new version from
    /// <paramref name="effectiveFrom"/> and the old version ends the day before, so history is kept (BR-CON-03).
    /// </summary>
    public Result<ContractLine> ReviseLine(Guid lineId, LineTerms terms, DateOnly effectiveFrom)
    {
        if (Status == ContractStatus.Ended)
        {
            return ContractErrors.InvalidTransition(Status, "changed");
        }

        if (_lines.SingleOrDefault(l => l.Id == lineId) is not { } line)
        {
            return ContractErrors.LineNotFound(lineId);
        }

        if (Status == ContractStatus.Draft)
        {
            if (CheckLinePeriod(terms.ValidFrom, terms.ValidTo) is { } draftError)
            {
                return draftError;
            }

            line.Apply(terms with { ProductId = line.ProductId });
            return line;
        }

        if (effectiveFrom <= line.ValidFrom || (line.ValidTo is { } to && effectiveFrom > to))
        {
            return ContractErrors.RevisionDate;
        }

        var next = ContractLine.CreateVersion(line, terms with { ProductId = line.ProductId, ValidFrom = effectiveFrom, ValidTo = line.ValidTo });
        line.EndOn(effectiveFrom.AddDays(-1));
        _lines.Add(next);
        return next;
    }

    /// <summary>
    /// Yearly price indexation (BR-CON-06): every line with an own price gets a new version from the effective date with the
    /// price raised by the percentage. Lines that follow the price list are left alone — the price list itself is indexed.
    /// </summary>
    public Result<IReadOnlyList<IndexedLine>> Index(decimal percent, DateOnly effectiveFrom)
    {
        if (!IsLive)
        {
            return ContractErrors.InvalidTransition(Status, "indexed");
        }

        var changed = new List<IndexedLine>();
        foreach (var line in _lines.Where(l => l.Covers(effectiveFrom) && l.UnitPrice is not null).ToList())
        {
            var before = line.UnitPrice!.Value;
            var after = decimal.Round(before * (1 + (percent / 100m)), 2);
            if (after == before)
            {
                continue;
            }

            if (effectiveFrom <= line.ValidFrom)
            {
                // The line has not started billing yet on the effective date, so it simply carries the new price.
                line.Reprice(after);
            }
            else
            {
                var next = ContractLine.CreateVersion(line, line.Terms with { UnitPrice = after, ValidFrom = effectiveFrom });
                line.EndOn(effectiveFrom.AddDays(-1));
                _lines.Add(next);
            }

            changed.Add(new IndexedLine(line.SeriesId, line.ProductId, line.Description, line.Quantity, before, after));
        }

        NextIndexationDate = effectiveFrom.AddYears(1);
        return changed;
    }

    public Result EndLine(Guid lineId, DateOnly endDate)
    {
        if (_lines.SingleOrDefault(l => l.Id == lineId) is not { } line)
        {
            return ContractErrors.LineNotFound(lineId);
        }

        if (endDate < line.ValidFrom)
        {
            return ContractErrors.RevisionDate;
        }

        line.EndOn(endDate);
        return Result.Success();
    }

    public Result RemoveLine(Guid lineId)
    {
        if (Status != ContractStatus.Draft)
        {
            return Error.Conflict("CON_NOT_DRAFT", "Lines of a running contract are ended, not removed.");
        }

        if (_lines.SingleOrDefault(l => l.Id == lineId) is not { } line)
        {
            return ContractErrors.LineNotFound(lineId);
        }

        line.MarkDeleted();
        return Result.Success();
    }

    public IEnumerable<ContractLine> LinesOn(DateOnly date) => _lines.Where(l => !l.IsDeleted && l.Covers(date));

    public void LinkToQuote(Guid quoteId) => SourceQuoteId = quoteId;

    public void MoveToOrganization(Guid targetOrganizationId, Guid mergeId)
    {
        PreviousOrganizationId = OrganizationId;
        MovedByMergeId = mergeId;
        OrganizationId = targetOrganizationId;
    }

    public void UndoMove()
    {
        OrganizationId = PreviousOrganizationId ?? OrganizationId;
        PreviousOrganizationId = null;
        MovedByMergeId = null;
    }

    public override void MarkDeleted()
    {
        base.MarkDeleted();
        foreach (var line in _lines)
        {
            line.MarkDeleted();
        }
    }

    private Result Apply(ContractTerms t)
    {
        if (t.EndDate is { } end && end < t.StartDate)
        {
            return ContractErrors.InvalidPeriod;
        }

        Title = t.Title.Trim();
        Type = t.Type;
        StartDate = t.StartDate;
        EndDate = t.EndDate;
        AutoRenew = t.AutoRenew && t.EndDate is not null;
        RenewalTermMonths = t.RenewalTermMonths;
        NoticePeriodDays = t.NoticePeriodDays;
        SlaPolicyId = t.SlaPolicyId;
        InvoiceFrequency = t.InvoiceFrequency;
        InvoiceTiming = t.InvoiceTiming;
        PriceCategory = string.IsNullOrWhiteSpace(t.PriceCategory) ? null : t.PriceCategory.Trim().ToUpperInvariant();
        Indexation = t.Indexation;
        NextIndexationDate = t.Indexation ? t.NextIndexationDate : null;
        CustomerReference = string.IsNullOrWhiteSpace(t.CustomerReference) ? null : t.CustomerReference.Trim();
        OwnerId = t.OwnerId;
        Notes = string.IsNullOrWhiteSpace(t.Notes) ? null : t.Notes.Trim();
        return Result.Success();
    }

    private Error? CheckLinePeriod(DateOnly from, DateOnly? to)
    {
        if (to is { } end && end < from)
        {
            return ContractErrors.InvalidPeriod;
        }

        return from < StartDate || (EndDate is { } contractEnd && Status != ContractStatus.Draft && from > contractEnd)
            ? ContractErrors.LineOutsideContract
            : null;
    }
}

public sealed class ContractLine : AuditableEntity
{
    private ContractLine() { }

    public Guid ContractId { get; private set; }

    /// <summary>Shared by all versions of the same line.</summary>
    public Guid SeriesId { get; private set; }

    public int Version { get; private set; }
    public Guid ProductId { get; private set; }
    public string? Description { get; private set; }
    public QuantityModel QuantityModel { get; private set; }
    public DeviceFilter DeviceFilter { get; private set; }

    /// <summary>Fixed or manual quantity; for Atera/M365/subscription models the estimate until a snapshot is taken.</summary>
    public decimal Quantity { get; private set; }

    /// <summary>Individual price; null means the price list price of the contract's customer category (BR-CAT-01).</summary>
    public decimal? UnitPrice { get; private set; }

    public decimal DiscountPct { get; private set; }
    public DateOnly ValidFrom { get; private set; }
    public DateOnly? ValidTo { get; private set; }

    internal static ContractLine Create(Guid contractId, LineTerms terms)
    {
        var line = new ContractLine { ContractId = contractId, Version = 1 };
        line.SeriesId = line.Id;
        line.Apply(terms);
        return line;
    }

    internal static ContractLine CreateVersion(ContractLine previous, LineTerms terms)
    {
        var line = new ContractLine { ContractId = previous.ContractId, SeriesId = previous.SeriesId, Version = previous.Version + 1 };
        line.Apply(terms);
        return line;
    }

    internal void Apply(LineTerms t)
    {
        ProductId = t.ProductId;
        Description = string.IsNullOrWhiteSpace(t.Description) ? null : t.Description.Trim();
        QuantityModel = t.QuantityModel;
        DeviceFilter = t.QuantityModel == QuantityModel.PerAteraDevice ? t.DeviceFilter : DeviceFilter.All;
        Quantity = t.Quantity;
        UnitPrice = t.UnitPrice is { } price ? decimal.Round(price, 2) : null;
        DiscountPct = t.DiscountPct;
        ValidFrom = t.ValidFrom;
        ValidTo = t.ValidTo;
    }

    internal void EndOn(DateOnly date) => ValidTo = date;

    internal void Reprice(decimal unitPrice) => UnitPrice = decimal.Round(unitPrice, 2);

    internal LineTerms Terms => new(ProductId, Description, QuantityModel, DeviceFilter, Quantity, UnitPrice, DiscountPct, ValidFrom, ValidTo);

    public bool Covers(DateOnly date) => ValidFrom <= date && (ValidTo is null || date <= ValidTo);

    public static decimal Amount(decimal quantity, decimal unitPrice, decimal discountPct) =>
        decimal.Round(quantity * unitPrice * (1 - (discountPct / 100m)), 2);
}
