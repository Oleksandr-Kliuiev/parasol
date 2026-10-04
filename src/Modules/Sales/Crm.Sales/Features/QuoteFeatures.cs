using Crm.Authorization;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using FluentValidation;

namespace Crm.Sales.Features;

public sealed record QuoteTemplateRequest(
    string Name, string Language, string? IntroText, string? TermsText, string? FooterText, int ValidityDays, bool IsActive = true, bool IsDefault = false);

public sealed record QuoteTemplateDto(
    Guid Id, string Name, string Language, string? IntroText, string? TermsText, string? FooterText, int ValidityDays, bool IsDefault, bool IsActive, string Etag);

public sealed record QuoteLineRequest(
    Guid? ProductId,
    string? Sku,
    string Name,
    string? Description,
    decimal Quantity,
    decimal? UnitPrice,
    decimal DiscountPct,
    QuoteLineRecurrence Recurrence,
    decimal? VatRate);

/// <param name="OwnerId">
/// The owner; left out on create it is the caller, left out on update it stays as it is — an owner changes only to a person
/// named, within the caller's record scope (DEV-09).
/// </param>
public sealed record QuoteRequest(
    Guid OrganizationId,
    Guid? ContactId,
    Guid? OpportunityId,
    string Title,
    Guid? OwnerId,
    string? Language,
    DateOnly? ValidUntil,
    int TermMonths,
    Guid? TemplateId,
    string? IntroText,
    string? TermsText,
    string? CustomerReference,
    IReadOnlyList<QuoteLineRequest>? Lines);

public sealed record RejectQuoteRequest(string Reason);

public sealed record DeclineQuoteRequest(string? Reason);

/// <summary>Hands the quote to another person (DEV-09).</summary>
public sealed record TransferQuoteRequest(Guid OwnerId);

internal sealed class TransferQuoteRequestValidator : AbstractValidator<TransferQuoteRequest>
{
    public TransferQuoteRequestValidator() => RuleFor(x => x.OwnerId).NotEmpty();
}

public sealed record SendQuoteRequest(string ToAddress, string? ToName, IReadOnlyList<string>? Cc, string? Subject, string? Message);

public sealed record QuoteLineDto(
    Guid Id,
    Guid? ProductId,
    string? Sku,
    string Name,
    string? Description,
    decimal Quantity,
    [property: SensitiveData(Permissions.FinanceRead)] decimal UnitPrice,
    decimal DiscountPct,
    QuoteLineRecurrence Recurrence,
    decimal VatRate,
    [property: SensitiveData(Permissions.FinanceRead)] decimal NetAmount,
    int Sort);

/// <summary>One entry of the version history of a quote (BR-SAL-04).</summary>
public sealed record QuoteVersionDto(Guid Id, int VersionNo, QuoteStatus Status, DateOnly IssuedOn, DateTimeOffset? SentAt);

public sealed record QuoteDto(
    Guid Id,
    string Number,
    Guid RootId,
    int VersionNo,
    RefDto Organization,
    Guid? ContactId,
    string? ContactName,
    Guid? OpportunityId,
    string? OpportunityName,
    string Title,
    RefDto? Owner,
    string Language,
    DateOnly IssuedOn,
    DateOnly ValidUntil,
    int TermMonths,
    string? IntroText,
    string? TermsText,
    string? CustomerReference,
    QuoteStatus Status,
    decimal MaxDiscountPct,
    decimal DiscountLimitPct,
    bool NeedsApproval,
    RefDto? ApprovalRequestedBy,
    DateTimeOffset? ApprovalRequestedAt,
    RefDto? ApprovedBy,
    DateTimeOffset? ApprovedAt,
    string? RejectedReason,
    DateTimeOffset? SentAt,
    string? SentTo,
    DateOnly? DecidedOn,
    string? DeclineReason,
    bool IsEditable,
    bool HasDocument,
    bool CanSendByEmail,
    [property: SensitiveData(Permissions.FinanceRead)] decimal OneTimeExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal OneTimeVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal ContractValue,
    IReadOnlyList<QuoteLineDto> Lines,
    IReadOnlyList<QuoteVersionDto> Versions,
    IReadOnlyList<QuoteDocumentDto> Documents,
    string Etag);

public sealed record QuoteListItem(
    Guid Id,
    string Number,
    int VersionNo,
    RefDto Organization,
    string Title,
    QuoteStatus Status,
    DateOnly IssuedOn,
    DateOnly ValidUntil,
    RefDto? Owner,
    decimal MaxDiscountPct,
    [property: SensitiveData(Permissions.FinanceRead)] decimal MonthlyExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal OneTimeExVat,
    [property: SensitiveData(Permissions.FinanceRead)] decimal ContractValue,
    bool IsLatestVersion,
    string Etag);

public sealed record QuoteQuery(string? Search, Guid? OrganizationId, Guid? OpportunityId, QuoteStatus? Status, bool MineOnly, bool AwaitingApproval);

/// <summary>A stored quote document as it is downloaded (DEV-08).</summary>
public sealed record QuoteFile(byte[] Content, string FileName, int Revision, QuoteDocumentOrigin Origin, string Sha256)
{
    public const string ContentType = QuoteDocument.PdfMediaType;
}

/// <summary>
/// One document of a quote version (DEV-08): its revision, whether it was issued at release or reconstructed later, whether
/// it is stored yet, and the SHA-256 of the stored PDF.
/// </summary>
public sealed record QuoteDocumentDto(
    int Revision,
    QuoteDocumentOrigin Origin,
    QuoteDocumentStatus Status,
    string FileName,
    long? Length,
    string? Sha256,
    string? RendererVersion,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ReadyAt);

internal sealed class QuoteRequestValidator : AbstractValidator<QuoteRequest>
{
    public QuoteRequestValidator()
    {
        RuleFor(x => x.OrganizationId).NotEmpty();
        RuleFor(x => x.Title).NotEmpty().MaximumLength(256);
        RuleFor(x => x.TermMonths).InclusiveBetween(0, 120);
        RuleFor(x => x.Language).Must(v => v is null or "nb" or "en").WithMessage("The document language is nb or en.");
        RuleFor(x => x.IntroText).MaximumLength(4000);
        RuleFor(x => x.TermsText).MaximumLength(8000);
        RuleFor(x => x.CustomerReference).MaximumLength(128);
        RuleFor(x => x.Lines).Must(lines => lines is null || lines.Count <= 200).WithMessage("A quote holds at most 200 lines.");
        RuleForEach(x => x.Lines).ChildRules(line =>
        {
            line.RuleFor(l => l.Name).NotEmpty().MaximumLength(256);
            line.RuleFor(l => l.Description).MaximumLength(1000);
            line.RuleFor(l => l.Sku).MaximumLength(64);
            line.RuleFor(l => l.Quantity).GreaterThan(0).LessThanOrEqualTo(100_000);
            line.RuleFor(l => l.UnitPrice).InclusiveBetween(0, 100_000_000).When(l => l.UnitPrice is not null);
            line.RuleFor(l => l.DiscountPct).InclusiveBetween(0, 100);
            line.RuleFor(l => l.VatRate).InclusiveBetween(0, 100).When(l => l.VatRate is not null);
        });
    }
}

internal sealed class QuoteTemplateRequestValidator : AbstractValidator<QuoteTemplateRequest>
{
    public QuoteTemplateRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Language).Must(v => v is "nb" or "en").WithMessage("A template is written in nb or en.");
        RuleFor(x => x.IntroText).MaximumLength(4000);
        RuleFor(x => x.TermsText).MaximumLength(8000);
        RuleFor(x => x.FooterText).MaximumLength(512);
        RuleFor(x => x.ValidityDays).InclusiveBetween(1, 365);
    }
}

internal sealed class SendQuoteRequestValidator : AbstractValidator<SendQuoteRequest>
{
    public SendQuoteRequestValidator()
    {
        RuleFor(x => x.ToAddress).NotEmpty().EmailAddress().MaximumLength(256);
        RuleFor(x => x.ToName).MaximumLength(256);
        RuleFor(x => x.Subject).MaximumLength(256);
        RuleFor(x => x.Message).MaximumLength(4000);
        RuleFor(x => x.Cc).Must(cc => cc is null || cc.Count <= 5).WithMessage("At most five people can be copied.");
        RuleForEach(x => x.Cc).EmailAddress();
    }
}

internal sealed class RejectQuoteRequestValidator : AbstractValidator<RejectQuoteRequest>
{
    public RejectQuoteRequestValidator() => RuleFor(x => x.Reason).NotEmpty().MaximumLength(512);
}
