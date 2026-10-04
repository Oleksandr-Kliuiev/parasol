using System.Globalization;
using Crm.Authorization;
using Crm.Catalog.Contracts;
using Crm.Contracts.Contracts;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Crm.Sales.Features;

/// <summary>
/// Quotes (FR-SAL-03..05): the editor, the versions, the discount approval and the document that goes out. The prices of a
/// version are resolved once and then frozen with it (BR-SAL-06).
/// </summary>
internal sealed class QuoteService(
    SalesDbContext db,
    ICustomersApi customers,
    ICatalogApi catalog,
    IContractsApi contracts,
    IUserDirectory users,
    ICurrentUser currentUser,
    IEnumerable<IQuoteMailSender> mailSenders,
    QuoteDocuments documents,
    IRecordScope scope,
    IOptions<SalesOptions> options,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    private SalesOptions Settings => options.Value;

    private IQuoteMailSender? MailSender => mailSenders.FirstOrDefault(s => s.IsConfigured);

    // ---------- Templates ----------

    public async Task<IReadOnlyList<QuoteTemplateDto>> ListTemplatesAsync(bool includeInactive, CancellationToken ct)
    {
        var templates = await db.QuoteTemplates.Where(t => includeInactive || t.IsActive).OrderBy(t => t.Language).ThenBy(t => t.Name).ToListAsync(ct);
        return templates.Select(t => new QuoteTemplateDto(
            t.Id, t.Name, t.Language, t.IntroText, t.TermsText, t.FooterText, t.ValidityDays, t.IsDefault, t.IsActive, db.GetETag(t))).ToList();
    }

    public async Task<Result<QuoteTemplateDto>> SaveTemplateAsync(Guid? id, QuoteTemplateRequest request, string? ifMatch, CancellationToken ct)
    {
        var data = new QuoteTemplateData(request.Name, request.Language, request.IntroText, request.TermsText, request.FooterText, request.ValidityDays, request.IsActive);
        QuoteTemplate template;
        if (id is null)
        {
            var created = QuoteTemplate.Create(data);
            if (!created.IsSuccess)
            {
                return created.Error!;
            }

            template = created.Value;
            db.QuoteTemplates.Add(template);
        }
        else
        {
            if (await db.QuoteTemplates.SingleOrDefaultAsync(t => t.Id == id, ct) is not { } existing)
            {
                return Error.NotFound("SAL_TEMPLATE_NOT_FOUND", $"Quote template {id} was not found.");
            }

            if (ifMatch is null || !db.ApplyIfMatch(existing, ifMatch))
            {
                return SalesErrors.InvalidETag;
            }

            var updated = existing.Update(data);
            if (!updated.IsSuccess)
            {
                return updated.Error!;
            }

            template = existing;
        }

        if (request.IsDefault && request.IsActive)
        {
            // One default per language, so a new quote never has to ask which wording to use.
            foreach (var other in await db.QuoteTemplates.Where(t => t.Language == template.Language && t.Id != template.Id && t.IsDefault).ToListAsync(ct))
            {
                other.ClearDefault();
            }

            template.MakeDefault();
        }
        else
        {
            template.ClearDefault();
        }

        await db.SaveChangesAsync(ct);
        return (await ListTemplatesAsync(true, ct)).First(t => t.Id == template.Id);
    }

    // ---------- Quotes ----------

    /// <summary>
    /// One page of quote versions in the caller's scope, newest number first (DEV-12): the count covers every version the filter
    /// matches, and whether a version is the latest is asked of all its siblings, not of the page.
    /// </summary>
    public async Task<PagedResult<QuoteListItem>> ListAsync(QuoteQuery query, CancellationToken ct)
    {
        var quotes = InScope(db.Quotes.Include(q => q.Lines));
        if (query.OrganizationId is { } organizationId)
        {
            quotes = quotes.Where(q => q.OrganizationId == organizationId);
        }

        if (query.OpportunityId is { } opportunityId)
        {
            quotes = quotes.Where(q => q.OpportunityId == opportunityId);
        }

        if (query.Status is { } status)
        {
            quotes = quotes.Where(q => q.Status == status);
        }

        if (query.AwaitingApproval)
        {
            quotes = quotes.Where(q => q.Status == QuoteStatus.PendingApproval);
        }

        if (query.MineOnly)
        {
            var userId = currentUser.UserId;
            quotes = quotes.Where(q => q.OwnerId == userId);
        }

        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var term = query.Search.Trim();
            quotes = quotes.Where(q => q.Number.Contains(term) || q.Title.Contains(term));
        }

        var total = await quotes.CountAsync(ct);
        if (KeysetCursor.Decode(query.Cursor) is { } cursor && int.TryParse(cursor.Then, NumberStyles.None, CultureInfo.InvariantCulture, out var version))
        {
            quotes = quotes.Where(q => q.Number.CompareTo(cursor.SortKey) < 0 ||
                                       (q.Number == cursor.SortKey && (q.VersionNo < version || (q.VersionNo == version && q.Id.CompareTo(cursor.Id) < 0))));
        }

        var limit = KeysetCursor.ClampLimit(query.Limit);
        var page = await quotes.OrderByDescending(q => q.Number).ThenByDescending(q => q.VersionNo).ThenByDescending(q => q.Id).Take(limit + 1).ToListAsync(ct);
        var rows = page.Take(limit).ToList();
        var roots = rows.Select(q => q.RootId).Distinct().ToList();
        var latest = await db.Quotes.AsNoTracking().Where(q => roots.Contains(q.RootId))
            .GroupBy(q => q.RootId).Select(g => new { g.Key, Latest = g.Max(q => q.VersionNo) })
            .ToDictionaryAsync(g => g.Key, g => g.Latest, ct);
        var organizations = await customers.GetOrganizationNamesAsync(rows.Select(q => q.OrganizationId).Distinct().ToList(), ct);
        var owners = await users.GetUsersAsync(rows.Where(q => q.OwnerId is not null).Select(q => q.OwnerId!.Value).Distinct().ToList(), ct);
        var items = rows.Select(q => new QuoteListItem(
            q.Id,
            q.Number,
            q.VersionNo,
            new RefDto(q.OrganizationId, organizations.GetValueOrDefault(q.OrganizationId, "—")),
            q.Title,
            q.Status,
            q.IssuedOn,
            q.ValidUntil,
            OwnerRef(q.OwnerId, owners),
            q.MaxDiscountPct,
            q.MonthlyExVat,
            q.OneTimeExVat,
            q.ContractValue,
            latest.GetValueOrDefault(q.RootId) == q.VersionNo,
            db.GetETag(q))).ToList();
        var last = rows.LastOrDefault();
        return new PagedResult<QuoteListItem>(
            items,
            page.Count > limit && last is not null
                ? new KeysetCursor(last.Number, last.Id, last.VersionNo.ToString(CultureInfo.InvariantCulture)).Encode()
                : null,
            total);
    }

    public async Task<Result<QuoteDto>> GetAsync(Guid id, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        return await ToDtoAsync(quote, ct);
    }

    public async Task<Result<QuoteDto>> CreateAsync(QuoteRequest request, CancellationToken ct)
    {
        var owner = request.OwnerId ?? currentUser.UserId;
        if (OwnerNotAllowed(owner, current: null) is { } notAllowed)
        {
            return notAllowed;
        }

        var template = await ResolveTemplateAsync(request, ct);
        var validity = template?.ValidityDays ?? Settings.QuoteValidityDays;
        var header = new QuoteHeader(
            request.OrganizationId,
            request.ContactId,
            request.OpportunityId,
            request.Title,
            owner,
            request.Language ?? template?.Language ?? "nb",
            request.ValidUntil ?? Today.AddDays(Math.Max(validity, 1)),
            request.TermMonths,
            request.IntroText ?? template?.IntroText,
            request.TermsText ?? template?.TermsText,
            request.CustomerReference);

        var created = Quote.Create(await db.NextQuoteNumberAsync(Today.Year, ct), header, Today);
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        var quote = created.Value;
        db.Quotes.Add(quote);
        var lines = await ResolveLinesAsync(request.Lines, request.OrganizationId, ct);
        if (!lines.IsSuccess)
        {
            return lines.Error!;
        }

        var replaced = quote.ReplaceLines(lines.Value);
        if (!replaced.IsSuccess)
        {
            return replaced.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(quote, ct);
    }

    public async Task<Result<QuoteDto>> UpdateAsync(Guid id, QuoteRequest request, string ifMatch, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(quote, ifMatch))
        {
            return SalesErrors.InvalidETag;
        }

        // Leaving the owner out keeps it: a quote never loses its owner by omission (DEV-09).
        var owner = request.OwnerId ?? quote.OwnerId;
        if (OwnerNotAllowed(owner, quote.OwnerId) is { } notAllowed)
        {
            return notAllowed;
        }

        var header = new QuoteHeader(
            request.OrganizationId,
            request.ContactId,
            request.OpportunityId,
            request.Title,
            owner,
            request.Language ?? quote.Language,
            request.ValidUntil ?? quote.ValidUntil,
            request.TermMonths,
            request.IntroText,
            request.TermsText,
            request.CustomerReference);

        var updated = quote.Update(header, quote.IssuedOn);
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        if (request.Lines is not null)
        {
            var lines = await ResolveLinesAsync(request.Lines, request.OrganizationId, ct);
            if (!lines.IsSuccess)
            {
                return lines.Error!;
            }

            var replaced = quote.ReplaceLines(lines.Value);
            if (!replaced.IsSuccess)
            {
                return replaced.Error!;
            }
        }

        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(quote, ct);
    }

    /// <summary>Releases the quote, or asks management for the discount first (BR-SAL-05).</summary>
    public Task<Result<QuoteDto>> SubmitAsync(Guid id, CancellationToken ct) =>
        ReleaseAsync(id, quote => quote.Submit(
            Settings.DiscountLimitPercent, currentUser.HasPermission(Permissions.SalesDiscountApprove), currentUser.UserId, time.GetUtcNow()), ct);

    public Task<Result<QuoteDto>> ApproveAsync(Guid id, CancellationToken ct) =>
        ReleaseAsync(id, quote => quote.Approve(currentUser.UserId, time.GetUtcNow()), ct);

    public Task<Result<QuoteDto>> RejectAsync(Guid id, string reason, CancellationToken ct) =>
        MutateAsync(id, quote => quote.Reject(reason), ct);

    public Task<Result<QuoteDto>> WithdrawAsync(Guid id, CancellationToken ct) =>
        MutateAsync(id, quote => quote.Withdraw(), ct);

    public Task<Result<QuoteDto>> DeclineAsync(Guid id, string? reason, CancellationToken ct) =>
        MutateAsync(id, quote => quote.Decline(reason, Today), ct);

    public Task<Result<QuoteDto>> CancelAsync(Guid id, CancellationToken ct) =>
        MutateAsync(id, quote => quote.Cancel(), ct);

    /// <summary>BR-SAL-07: the deal is won and the accepted lines become a draft contract and a one-time charge.</summary>
    public async Task<Result<QuoteDto>> AcceptAsync(Guid id, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        var accepted = quote.Accept(Today);
        if (!accepted.IsSuccess)
        {
            return accepted.Error!;
        }

        if (quote.OpportunityId is { } opportunityId
            && await db.Opportunities.SingleOrDefaultAsync(o => o.Id == opportunityId, ct) is { Status: OpportunityStatus.Open } opportunity
            && await db.PipelineStages.FirstOrDefaultAsync(s => s.IsWon && s.IsActive, ct) is { } wonStage)
        {
            opportunity.MoveTo(wonStage.Id, wonStage.Probability, true, false, null, Today, time.GetUtcNow());
        }

        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(quote, ct);
    }

    /// <summary>Starts version v+1 as a fresh draft and leaves the current one as history (BR-SAL-04).</summary>
    public async Task<Result<QuoteDto>> ReviseAsync(Guid id, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        var revised = quote.Revise(Today, Settings.QuoteValidityDays);
        if (!revised.IsSuccess)
        {
            return revised.Error!;
        }

        db.Quotes.Add(revised.Value);
        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(revised.Value, ct);
    }

    /// <summary>
    /// Hands a quote to another person (DEV-09): the current version gets the new owner, and with it the whole quote. The
    /// caller keeps seeing it only through a role that sees every quote; the change is in the audit log.
    /// </summary>
    public async Task<Result> TransferAsync(Guid id, TransferQuoteRequest request, string ifMatch, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        if (!db.ApplyIfMatch(quote, ifMatch))
        {
            return SalesErrors.InvalidETag;
        }

        if (await db.Quotes.AnyAsync(v => v.RootId == quote.RootId && v.VersionNo > quote.VersionNo, ct))
        {
            return QuoteErrors.NotCurrent;
        }

        if (await users.GetProfileAsync(request.OwnerId, ct) is not { IsActive: true })
        {
            return QuoteErrors.UnknownOwner(request.OwnerId);
        }

        quote.TransferTo(request.OwnerId);
        await db.SaveChangesAsync(ct);
        return Result.Success();
    }

    /// <summary>FR-SAL-04: the PDF leaves from the salesperson's own mailbox, so the reply comes back to them.</summary>
    public async Task<Result<QuoteDto>> SendAsync(Guid id, SendQuoteRequest request, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        if (!quote.HasDocument)
        {
            return Error.Conflict(
                "SAL_QUOTE_NOT_RELEASED",
                "The quote has to be released (and the discount approved) before it can be sent (BR-SAL-05).");
        }

        if (MailSender is not { } sender)
        {
            return Error.Conflict(
                "SAL_MAIL_DISABLED",
                "Sending quotes by e-mail is switched off (Sales:EmailEnabled). Download the PDF and send it from Outlook.");
        }

        var senderProfile = currentUser.UserId is { } userId ? await users.GetProfileAsync(userId, ct) : null;
        if (senderProfile?.Email is not { Length: > 0 } senderAddress)
        {
            return Error.Conflict("SAL_SENDER_WITHOUT_MAILBOX", "Your CRM profile has no e-mail address to send from.");
        }

        // DEV-08: the attachment is the stored document — the same bytes a download returns — and nothing goes out before it
        // is stored.
        var delivery = await documents.ForDeliveryAsync(quote, null, ct);
        if (!delivery.IsSuccess)
        {
            return delivery.Error!;
        }

        var texts = QuoteTexts.For(quote.Language);
        var subject = string.IsNullOrWhiteSpace(request.Subject) ? $"{texts.Quote} {quote.Number} – {quote.Title}" : request.Subject.Trim();
        await sender.SendAsync(
            new QuoteMail(
                senderAddress,
                request.ToAddress.Trim(),
                request.ToName,
                request.Cc ?? [],
                subject,
                Body(request.Message, quote, senderProfile.DisplayName, texts),
                delivery.Value.Document.FileName,
                delivery.Value.Content),
            ct);

        var sent = quote.MarkSent(currentUser.UserId, request.ToAddress.Trim(), time.GetUtcNow());
        if (!sent.IsSuccess)
        {
            return sent.Error!;
        }

        // A quote that goes out is activity on the deal, so it does not turn stale the next day (BR-SAL-03).
        if (quote.OpportunityId is { } opportunityId
            && await db.Opportunities.SingleOrDefaultAsync(o => o.Id == opportunityId, ct) is { } opportunity)
        {
            opportunity.RecordActivity(time.GetUtcNow());
        }

        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(quote, ct);
    }

    public async Task<Result<QuoteFile>> RenderAsync(Guid id, int? revision, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        if (!currentUser.HasPermission(Permissions.FinanceRead))
        {
            return new Error("SAL_QUOTE_PRICES_HIDDEN", "The quote document shows prices, which your role cannot see.", ErrorType.Forbidden);
        }

        if (!quote.HasDocument)
        {
            return Error.Conflict(
                "SAL_QUOTE_NOT_RELEASED",
                quote.Status == QuoteStatus.PendingApproval
                    ? "The discount is waiting for approval; there is no document until it is given (BR-SAL-05)."
                    : "Release the quote first — a draft has no document.",
                new Dictionary<string, object?> { ["status"] = quote.Status.ToString() });
        }

        var delivery = await documents.ForDeliveryAsync(quote, revision, ct);
        return delivery.IsSuccess
            ? new QuoteFile(delivery.Value.Content, delivery.Value.Document.FileName, delivery.Value.Document.Revision, delivery.Value.Document.Origin, delivery.Value.Document.ContentSha256!)
            : delivery.Error!;
    }

    // ---------- Internals ----------

    /// <summary>
    /// A transition that may release the version (BR-SAL-05). Released, its document is frozen in the same transaction and
    /// then stored; if storage is away the document stays Preparing and the quote cannot be sent until it is stored (DEV-08).
    /// </summary>
    private async Task<Result<QuoteDto>> ReleaseAsync(Guid id, Func<Quote, Result> change, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        var result = change(quote);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        var document = quote.Status == QuoteStatus.Ready ? await documents.PrepareAsync(quote, QuoteDocumentOrigin.Issued, ct) : null;
        await db.SaveChangesAsync(ct);
        if (document is not null)
        {
            await documents.TryCompleteAsync(document.Id, ct);
        }

        return await ToDtoAsync(quote, ct);
    }

    private static string Body(string? message, Quote quote, string senderName, QuoteTexts texts)
    {
        var greeting = string.IsNullOrWhiteSpace(message)
            ? (quote.Language == "en"
                ? $"Please find our quote {quote.Number} attached."
                : $"Vedlagt følger tilbud {quote.Number}.")
            : message.Trim();
        var closing = quote.Language == "en" ? "Kind regards" : "Med vennlig hilsen";
        return $"<p>{Html(greeting).Replace("\n", "<br>", StringComparison.Ordinal)}</p>"
               + $"<p>{Html(texts.Quote)} {Html(quote.Number)} · {Html(quote.Title)}<br>"
               + $"{Html(texts.ValidUntil)}: {quote.ValidUntil:dd.MM.yyyy}</p>"
               + $"<p>{Html(closing)}<br>{Html(senderName)}</p>";
    }

    private static string Html(string value) => System.Net.WebUtility.HtmlEncode(value);

    private async Task<QuoteTemplate?> ResolveTemplateAsync(QuoteRequest request, CancellationToken ct)
    {
        if (request.TemplateId is { } templateId)
        {
            return await db.QuoteTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Id == templateId, ct);
        }

        var language = request.Language ?? "nb";
        return await db.QuoteTemplates.AsNoTracking().FirstOrDefaultAsync(t => t.Language == language && t.IsDefault && t.IsActive, ct);
    }

    /// <summary>
    /// Turns the request lines into frozen ones: a line that names a product but no price gets today's price for the
    /// customer's category, and the product's VAT rate and SKU come along (BR-SAL-06).
    /// </summary>
    private async Task<Result<IReadOnlyList<QuoteLineData>>> ResolveLinesAsync(IReadOnlyList<QuoteLineRequest>? requested, Guid organizationId, CancellationToken ct)
    {
        if (requested is null or { Count: 0 })
        {
            return Result<IReadOnlyList<QuoteLineData>>.Success([]);
        }

        var productIds = requested.Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        var products = productIds.Count > 0 ? await catalog.GetProductsAsync(productIds, ct) : new Dictionary<Guid, ProductRef>();
        var prices = new Dictionary<Guid, ResolvedPrice>();
        if (productIds.Count > 0 && requested.Any(l => l.ProductId is not null && l.UnitPrice is null))
        {
            var terms = await contracts.GetBillingTermsAsync(organizationId, Today, ct);
            var category = terms.Contract?.PriceCategory ?? await catalog.GetDefaultCategoryAsync(ct);
            prices = (await catalog.ResolvePricesAsync(productIds, category, Today, ct)).ToDictionary(p => p.Key, p => p.Value);
        }

        var lines = new List<QuoteLineData>(requested.Count);
        foreach (var line in requested)
        {
            ProductRef? product = line.ProductId is { } productId && products.TryGetValue(productId, out var found) ? found : null;
            if (line.ProductId is not null && product is null)
            {
                return Error.Validation("SAL_QUOTE_PRODUCT_NOT_FOUND", "One of the lines names a product that no longer exists.");
            }

            var unitPrice = line.UnitPrice
                            ?? (line.ProductId is { } id && prices.TryGetValue(id, out var price) ? price.UnitPrice : 0m);
            lines.Add(new QuoteLineData(
                line.ProductId,
                line.Sku ?? product?.Sku,
                string.IsNullOrWhiteSpace(line.Name) ? product?.Name ?? string.Empty : line.Name,
                line.Description,
                line.Quantity,
                unitPrice,
                line.DiscountPct,
                line.Recurrence,
                line.VatRate ?? product?.VatRate ?? 25m));
        }

        return lines;
    }

    private async Task<Result<QuoteDto>> MutateAsync(Guid id, Func<Quote, Result> change, CancellationToken ct)
    {
        if (await LoadAsync(id, ct) is not { } quote)
        {
            return QuoteErrors.NotFound(id);
        }

        var result = change(quote);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        await db.SaveChangesAsync(ct);
        return await ToDtoAsync(quote, ct);
    }

    // Every load by id goes through the caller's scope: a quote outside it does not exist for them (404, not 403), so ids
    // reveal nothing (DEV-09).
    private async Task<Quote?> LoadAsync(Guid id, CancellationToken ct) =>
        await InScope(db.Quotes.Include(q => q.Lines)).SingleOrDefaultAsync(q => q.Id == id, ct);

    /// <summary>
    /// The quotes the caller may see (DEV-09): all of them, or — limited to its own — those whose newest version it owns. The
    /// whole quote follows its current version: a transfer moves the earlier versions along, and a version is never visible
    /// without its siblings.
    /// </summary>
    private IQueryable<Quote> InScope(IQueryable<Quote> quotes) =>
        scope.LimitedTo(Permissions.QuotesAll) is { } userId
            ? quotes.Where(q => db.Quotes
                .Where(v => v.RootId == q.RootId)
                .OrderByDescending(v => v.VersionNo)
                .Select(v => v.OwnerId)
                .FirstOrDefault() == userId)
            : quotes;

    /// <summary>
    /// Who may be named owner (DEV-09). A role that sees every quote names anyone; one limited to its own quotes keeps them
    /// its own — handing one over is an explicit transfer, after which the quote is no longer theirs to see.
    /// </summary>
    private Error? OwnerNotAllowed(Guid? requested, Guid? current) =>
        scope.LimitedTo(Permissions.QuotesAll) is { } userId && requested != current && requested != userId
            ? QuoteErrors.OwnerNotAllowed
            : null;

    private async Task<QuoteDto> ToDtoAsync(Quote quote, CancellationToken ct)
    {
        var organization = await customers.GetOrganizationAsync(quote.OrganizationId, ct);
        var contactNames = quote.ContactId is { } contactId
            ? await customers.GetContactNamesAsync([contactId], ct)
            : new Dictionary<Guid, string>();
        var opportunity = quote.OpportunityId is { } opportunityId
            ? (await db.Opportunities.AsNoTracking().Where(o => o.Id == opportunityId).Select(o => new { o.Id, o.Name }).FirstOrDefaultAsync(ct))
            : null;
        var userIds = new[] { quote.OwnerId, quote.ApprovalRequestedBy, quote.ApprovedBy }.OfType<Guid>().Distinct().ToList();
        var people = await users.GetUsersAsync(userIds, ct);
        var versions = await db.Quotes.AsNoTracking()
            .Where(q => q.RootId == quote.RootId)
            .OrderBy(q => q.VersionNo)
            .Select(q => new QuoteVersionDto(q.Id, q.VersionNo, q.Status, q.IssuedOn, q.SentAt))
            .ToListAsync(ct);

        return new QuoteDto(
            quote.Id,
            quote.Number,
            quote.RootId,
            quote.VersionNo,
            new RefDto(quote.OrganizationId, organization?.Name ?? "—"),
            quote.ContactId,
            quote.ContactId is { } id ? contactNames.GetValueOrDefault(id) : null,
            quote.OpportunityId,
            opportunity?.Name,
            quote.Title,
            OwnerRef(quote.OwnerId, people),
            quote.Language,
            quote.IssuedOn,
            quote.ValidUntil,
            quote.TermMonths,
            quote.IntroText,
            quote.TermsText,
            quote.CustomerReference,
            quote.Status,
            quote.MaxDiscountPct,
            Settings.DiscountLimitPercent,
            quote.MaxDiscountPct > Settings.DiscountLimitPercent,
            OwnerRef(quote.ApprovalRequestedBy, people),
            quote.ApprovalRequestedAt,
            OwnerRef(quote.ApprovedBy, people),
            quote.ApprovedAt,
            quote.RejectedReason,
            quote.SentAt,
            quote.SentTo,
            quote.DecidedOn,
            quote.DeclineReason,
            quote.IsEditable,
            quote.HasDocument,
            MailSender is not null,
            quote.OneTimeExVat,
            quote.OneTimeVat,
            quote.MonthlyExVat,
            quote.MonthlyVat,
            quote.ContractValue,
            quote.Lines.OrderBy(l => l.Sort).Select(l => new QuoteLineDto(
                l.Id, l.ProductId, l.Sku, l.Name, l.Description, l.Quantity, l.UnitPrice, l.DiscountPct, l.Recurrence, l.VatRate, l.NetAmount, l.Sort)).ToList(),
            versions,
            (await documents.ListAsync(quote.Id, ct)).Select(d => new QuoteDocumentDto(
                d.Revision, d.Origin, d.Status, d.FileName, d.Length, d.ContentSha256, d.RendererVersion, d.CreatedAt, d.ReadyAt)).ToList(),
            db.GetETag(quote));
    }

    private static RefDto? OwnerRef(Guid? userId, IReadOnlyDictionary<Guid, UserSummary> people) =>
        userId is { } id && people.TryGetValue(id, out var user) ? new RefDto(id, user.DisplayName) : null;
}

/// <summary>A product named on a quote line is in use and can only be deactivated (BR-CAT-03).</summary>
internal sealed class QuoteProductUsage(SalesDbContext db) : IProductUsage
{
    public Task<bool> IsUsedAsync(Guid productId, CancellationToken cancellationToken) =>
        db.QuoteLines.AnyAsync(l => l.ProductId == productId, cancellationToken);
}
