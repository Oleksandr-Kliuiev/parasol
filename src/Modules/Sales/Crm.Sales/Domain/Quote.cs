using Crm.Sales.Contracts;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;

namespace Crm.Sales.Domain;

/// <summary>Draft → Ready → Sent → Accepted / Declined / Expired; a revised version supersedes the one it came from (BR-SAL-04).</summary>
public enum QuoteStatus
{
    Draft,
    PendingApproval,
    Ready,
    Sent,
    Accepted,
    Declined,
    Expired,
    Superseded,
    Cancelled,
}

public sealed record QuoteHeader(
    Guid OrganizationId,
    Guid? ContactId,
    Guid? OpportunityId,
    string Title,
    Guid? OwnerId,
    string Language,
    DateOnly ValidUntil,
    int TermMonths,
    string? IntroText,
    string? TermsText,
    string? CustomerReference);

public sealed record QuoteLineData(
    Guid? ProductId,
    string? Sku,
    string Name,
    string? Description,
    decimal Quantity,
    decimal UnitPrice,
    decimal DiscountPct,
    QuoteLineRecurrence Recurrence,
    decimal VatRate);

internal static class QuoteErrors
{
    public static Error NotFound(Guid id) => Error.NotFound("SAL_QUOTE_NOT_FOUND", $"Quote {id} was not found.");

    public static Error NotEditable(QuoteStatus status) => Error.Conflict(
        "SAL_QUOTE_NOT_EDITABLE",
        $"A quote in status {status} cannot be changed; create a new version instead (BR-SAL-04).",
        new Dictionary<string, object?> { ["status"] = status.ToString() });

    public static Error OwnerNotAllowed => Error.Forbidden(
        "SAL_QUOTE_OWNER_NOT_ALLOWED", "You can only make yourself the owner of a quote; hand one over with a transfer (DEV-09).");

    public static Error NotCurrent => Error.Conflict(
        "SAL_QUOTE_NOT_CURRENT", "Only the current version of a quote can be handed over; its earlier versions follow it.");

    public static Error UnknownOwner(Guid id) => Error.Validation("SAL_QUOTE_OWNER_UNKNOWN", $"User {id} is not an active CRM user.");

    public static Error WrongStatus(QuoteStatus status, string action) => Error.Conflict(
        "SAL_QUOTE_STATUS",
        $"A quote in status {status} cannot be {action}.",
        new Dictionary<string, object?> { ["status"] = status.ToString() });
}

/// <summary>
/// One version of a quote (docs/02 §4.3). Versions of the same quote share <see cref="Number"/> and <see cref="RootId"/>;
/// only a draft can be edited and a sent version never changes again (BR-SAL-04), which is also what makes the PDF
/// reproducible — it is rendered from the version, not stored.
/// </summary>
public sealed class Quote : AuditableEntity
{
    private readonly List<QuoteLine> _lines = [];

    private Quote() { }

    public string Number { get; private set; } = string.Empty;

    /// <summary>Id of the first version; the whole version history of a quote shares it.</summary>
    public Guid RootId { get; private set; }

    public int VersionNo { get; private set; }

    public Guid OrganizationId { get; private set; }
    public Guid? ContactId { get; private set; }
    public Guid? OpportunityId { get; private set; }
    public string Title { get; private set; } = string.Empty;
    public Guid? OwnerId { get; private set; }

    /// <summary>Language of the document the customer receives: nb or en.</summary>
    public string Language { get; private set; } = "nb";

    public DateOnly IssuedOn { get; private set; }
    public DateOnly ValidUntil { get; private set; }

    /// <summary>Contract term the monthly lines are quoted for; the draft contract inherits it (BR-SAL-07).</summary>
    public int TermMonths { get; private set; }

    public string? IntroText { get; private set; }
    public string? TermsText { get; private set; }
    public string? CustomerReference { get; private set; }
    public QuoteStatus Status { get; private set; }

    /// <summary>Largest line discount, kept on the row so the approval queue is a plain query (BR-SAL-05).</summary>
    public decimal MaxDiscountPct { get; private set; }

    public Guid? ApprovalRequestedBy { get; private set; }
    public DateTimeOffset? ApprovalRequestedAt { get; private set; }
    public Guid? ApprovedBy { get; private set; }
    public DateTimeOffset? ApprovedAt { get; private set; }
    public string? RejectedReason { get; private set; }
    public Guid? SentBy { get; private set; }
    public DateTimeOffset? SentAt { get; private set; }
    public string? SentTo { get; private set; }
    public DateOnly? DecidedOn { get; private set; }
    public string? DeclineReason { get; private set; }

    public IReadOnlyList<QuoteLine> Lines => _lines;

    /// <summary>Everything the customer pays once — implementation, hardware, hour packages.</summary>
    public decimal OneTimeExVat => _lines.Where(l => l.Recurrence == QuoteLineRecurrence.OneTime).Sum(l => l.NetAmount);

    /// <summary>What the customer pays every month once the contract runs.</summary>
    public decimal MonthlyExVat => _lines.Where(l => l.Recurrence == QuoteLineRecurrence.Monthly).Sum(l => l.NetAmount);

    public decimal OneTimeVat => decimal.Round(
        _lines.Where(l => l.Recurrence == QuoteLineRecurrence.OneTime).Sum(l => l.NetAmount * l.VatRate / 100m), 2);

    public decimal MonthlyVat => decimal.Round(
        _lines.Where(l => l.Recurrence == QuoteLineRecurrence.Monthly).Sum(l => l.NetAmount * l.VatRate / 100m), 2);

    /// <summary>Value of the deal over the quoted term, the figure the forecast and the approval threshold look at.</summary>
    public decimal ContractValue => OneTimeExVat + (MonthlyExVat * Math.Max(TermMonths, 0));

    public bool IsEditable => Status is QuoteStatus.Draft or QuoteStatus.Ready;

    /// <summary>A document exists from the moment the quote is releasable; drafts and quotes awaiting approval have none (BR-SAL-05).</summary>
    public bool HasDocument => Status is not (QuoteStatus.Draft or QuoteStatus.PendingApproval or QuoteStatus.Cancelled);

    public static Result<Quote> Create(string number, QuoteHeader header, DateOnly today)
    {
        var quote = new Quote { Number = number, VersionNo = 1, IssuedOn = today, Status = QuoteStatus.Draft };
        quote.RootId = quote.Id;
        var applied = quote.Apply(header, today);
        return applied.IsSuccess ? quote : applied.Error!;
    }

    public Result Update(QuoteHeader header, DateOnly today)
    {
        if (!IsEditable)
        {
            return QuoteErrors.NotEditable(Status);
        }

        var applied = Apply(header, today);
        if (applied.IsSuccess)
        {
            BackToDraft();
        }

        return applied;
    }

    /// <summary>Replaces the lines of a draft. Prices are the ones resolved now and stay frozen in this version (BR-SAL-06).</summary>
    public Result ReplaceLines(IReadOnlyList<QuoteLineData> lines)
    {
        if (!IsEditable)
        {
            return QuoteErrors.NotEditable(Status);
        }

        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line.Name))
            {
                return Error.Validation("SAL_QUOTE_LINE_NAME", "Every quote line needs a name.");
            }

            if (line.Quantity <= 0)
            {
                return Error.Validation("SAL_QUOTE_LINE_QUANTITY", "A quote line must have a quantity above zero.");
            }

            if (line.UnitPrice < 0)
            {
                return Error.Validation("SAL_QUOTE_LINE_PRICE", "A quote line cannot have a negative price.");
            }

            if (line.DiscountPct is < 0 or > 100)
            {
                return Error.Validation("SAL_QUOTE_LINE_DISCOUNT", "A discount is between 0 and 100 %.");
            }
        }

        _lines.Clear();
        var sort = 0;
        foreach (var line in lines)
        {
            _lines.Add(QuoteLine.From(Id, line, ++sort));
        }

        MaxDiscountPct = _lines.Count == 0 ? 0m : _lines.Max(l => l.DiscountPct);
        BackToDraft();
        return Result.Success();
    }

    /// <summary>
    /// Releases the quote for sending. A discount above the limit of the person's role has to be approved by management
    /// first, and until it is there is no document to send (BR-SAL-05).
    /// </summary>
    public Result Submit(decimal discountLimitPct, bool mayApproveDiscount, Guid? userId, DateTimeOffset now)
    {
        if (Status is not (QuoteStatus.Draft or QuoteStatus.Ready))
        {
            return QuoteErrors.WrongStatus(Status, "submitted");
        }

        if (_lines.Count == 0)
        {
            return Error.Validation("SAL_QUOTE_EMPTY", "Add at least one line before sending the quote.");
        }

        if (MaxDiscountPct > discountLimitPct && !mayApproveDiscount)
        {
            Status = QuoteStatus.PendingApproval;
            ApprovalRequestedBy = userId;
            ApprovalRequestedAt = now;
            ApprovedBy = null;
            ApprovedAt = null;
            RejectedReason = null;
            return Result.Success();
        }

        Status = QuoteStatus.Ready;
        RejectedReason = null;
        if (MaxDiscountPct > discountLimitPct)
        {
            // The person who released it could have approved the discount anyway, so record that as the approval.
            ApprovedBy = userId;
            ApprovedAt = now;
        }

        return Result.Success();
    }

    public Result Approve(Guid? approverId, DateTimeOffset now)
    {
        if (Status != QuoteStatus.PendingApproval)
        {
            return QuoteErrors.WrongStatus(Status, "approved");
        }

        Status = QuoteStatus.Ready;
        ApprovedBy = approverId;
        ApprovedAt = now;
        RejectedReason = null;
        return Result.Success();
    }

    public Result Reject(string reason)
    {
        if (Status != QuoteStatus.PendingApproval)
        {
            return QuoteErrors.WrongStatus(Status, "rejected");
        }

        if (string.IsNullOrWhiteSpace(reason))
        {
            return Error.Validation("SAL_QUOTE_REJECT_REASON", "Say why the discount is not approved.");
        }

        Status = QuoteStatus.Draft;
        RejectedReason = reason.Trim();
        ApprovalRequestedBy = null;
        ApprovalRequestedAt = null;
        return Result.Success();
    }

    /// <summary>Takes an approval request back, so the quote can be edited again.</summary>
    public Result Withdraw()
    {
        if (Status != QuoteStatus.PendingApproval)
        {
            return QuoteErrors.WrongStatus(Status, "withdrawn");
        }

        Status = QuoteStatus.Draft;
        ApprovalRequestedBy = null;
        ApprovalRequestedAt = null;
        return Result.Success();
    }

    public Result MarkSent(Guid? userId, string toAddress, DateTimeOffset now)
    {
        if (Status is not (QuoteStatus.Ready or QuoteStatus.Sent))
        {
            return QuoteErrors.WrongStatus(Status, "sent");
        }

        Status = QuoteStatus.Sent;
        SentBy = userId;
        SentAt = now;
        SentTo = toAddress;
        return Result.Success();
    }

    /// <summary>BR-SAL-07: the deal is won, the recurring lines become a draft contract and the one-time lines wait for the next run.</summary>
    public Result Accept(DateOnly today)
    {
        if (Status is not (QuoteStatus.Sent or QuoteStatus.Ready))
        {
            return QuoteErrors.WrongStatus(Status, "accepted");
        }

        Status = QuoteStatus.Accepted;
        DecidedOn = today;
        DeclineReason = null;
        Raise(new QuoteAccepted(
            Id,
            Number,
            VersionNo,
            OrganizationId,
            OpportunityId,
            OwnerId,
            Title,
            today,
            TermMonths,
            _lines.OrderBy(l => l.Sort)
                .Select(l => new AcceptedQuoteLine(l.Id, l.ProductId, l.Name, l.Description, l.Quantity, l.UnitPrice, l.DiscountPct, l.VatRate, l.Recurrence))
                .ToList()));
        return Result.Success();
    }

    public Result Decline(string? reason, DateOnly today)
    {
        if (Status is not (QuoteStatus.Sent or QuoteStatus.Ready))
        {
            return QuoteErrors.WrongStatus(Status, "declined");
        }

        Status = QuoteStatus.Declined;
        DecidedOn = today;
        DeclineReason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim();
        return Result.Success();
    }

    /// <summary>Marks a sent quote whose validity ran out; the daily job calls it.</summary>
    public bool Expire(DateOnly today)
    {
        if (Status != QuoteStatus.Sent || ValidUntil >= today)
        {
            return false;
        }

        Status = QuoteStatus.Expired;
        return true;
    }

    public Result Cancel()
    {
        if (Status is QuoteStatus.Accepted or QuoteStatus.Superseded or QuoteStatus.Cancelled)
        {
            return QuoteErrors.WrongStatus(Status, "cancelled");
        }

        Status = QuoteStatus.Cancelled;
        return Result.Success();
    }

    /// <summary>
    /// Hands the quote to another owner (DEV-09), in any status: who answers for a sent or accepted quote can change too. The
    /// caller makes sure this is the current version, which the whole quote follows.
    /// </summary>
    public void TransferTo(Guid ownerId) => OwnerId = ownerId;

    /// <summary>Copies this version into a new draft (v2, v3 …) and leaves this one as history (BR-SAL-04).</summary>
    public Result<Quote> Revise(DateOnly today, int validityDays)
    {
        if (Status is QuoteStatus.Accepted or QuoteStatus.Superseded)
        {
            return QuoteErrors.WrongStatus(Status, "revised");
        }

        var next = new Quote
        {
            Number = Number,
            RootId = RootId,
            VersionNo = VersionNo + 1,
            OrganizationId = OrganizationId,
            ContactId = ContactId,
            OpportunityId = OpportunityId,
            Title = Title,
            OwnerId = OwnerId,
            Language = Language,
            IssuedOn = today,
            ValidUntil = today.AddDays(Math.Max(validityDays, 1)),
            TermMonths = TermMonths,
            IntroText = IntroText,
            TermsText = TermsText,
            CustomerReference = CustomerReference,
            Status = QuoteStatus.Draft,
            MaxDiscountPct = MaxDiscountPct,
        };

        foreach (var line in _lines.OrderBy(l => l.Sort))
        {
            next._lines.Add(QuoteLine.From(
                next.Id,
                new QuoteLineData(line.ProductId, line.Sku, line.Name, line.Description, line.Quantity, line.UnitPrice, line.DiscountPct, line.Recurrence, line.VatRate),
                line.Sort));
        }

        Status = Status == QuoteStatus.Cancelled ? QuoteStatus.Cancelled : QuoteStatus.Superseded;
        return next;
    }

    public void MoveToOrganization(Guid targetOrganizationId) => OrganizationId = targetOrganizationId;

    /// <summary>A released quote that is edited again goes back to being a draft, because the discount has to be judged anew.</summary>
    private void BackToDraft()
    {
        if (Status == QuoteStatus.Ready)
        {
            Status = QuoteStatus.Draft;
        }
    }

    private Result Apply(QuoteHeader header, DateOnly today)
    {
        if (string.IsNullOrWhiteSpace(header.Title))
        {
            return Error.Validation("SAL_QUOTE_TITLE_REQUIRED", "The quote needs a title.");
        }

        if (header.OrganizationId == Guid.Empty)
        {
            return Error.Validation("SAL_QUOTE_ORGANIZATION_REQUIRED", "Choose the customer the quote is for.");
        }

        if (header.ValidUntil < today)
        {
            return Error.Validation("SAL_QUOTE_VALID_UNTIL", "The quote cannot expire before it is written.");
        }

        if (header.TermMonths is < 0 or > 120)
        {
            return Error.Validation("SAL_QUOTE_TERM", "The contract term must be between 0 and 120 months.");
        }

        OrganizationId = header.OrganizationId;
        ContactId = header.ContactId;
        OpportunityId = header.OpportunityId;
        Title = header.Title.Trim();
        OwnerId = header.OwnerId;
        Language = header.Language is "en" ? "en" : "nb";
        ValidUntil = header.ValidUntil;
        TermMonths = header.TermMonths;
        IntroText = Clean(header.IntroText);
        TermsText = Clean(header.TermsText);
        CustomerReference = Clean(header.CustomerReference);
        return Result.Success();
    }

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

public sealed class QuoteLine : Entity
{
    private QuoteLine() { }

    public Guid QuoteId { get; private set; }
    public Guid? ProductId { get; private set; }
    public string? Sku { get; private set; }
    public string Name { get; private set; } = string.Empty;
    public string? Description { get; private set; }
    public decimal Quantity { get; private set; }

    /// <summary>Price at the moment the version was written; a new price list never changes a quote that is out (BR-SAL-06).</summary>
    public decimal UnitPrice { get; private set; }

    public decimal DiscountPct { get; private set; }
    public QuoteLineRecurrence Recurrence { get; private set; }
    public decimal VatRate { get; private set; }
    public int Sort { get; private set; }

    public decimal NetAmount => decimal.Round(Quantity * UnitPrice * (100m - DiscountPct) / 100m, 2, MidpointRounding.AwayFromZero);

    internal static QuoteLine From(Guid quoteId, QuoteLineData data, int sort) => new()
    {
        QuoteId = quoteId,
        ProductId = data.ProductId,
        Sku = string.IsNullOrWhiteSpace(data.Sku) ? null : data.Sku.Trim(),
        Name = data.Name.Trim(),
        Description = string.IsNullOrWhiteSpace(data.Description) ? null : data.Description.Trim(),
        Quantity = decimal.Round(data.Quantity, 2),
        UnitPrice = decimal.Round(data.UnitPrice, 2),
        DiscountPct = decimal.Round(data.DiscountPct, 2),
        Recurrence = data.Recurrence,
        VatRate = data.VatRate,
        Sort = sort,
    };
}
