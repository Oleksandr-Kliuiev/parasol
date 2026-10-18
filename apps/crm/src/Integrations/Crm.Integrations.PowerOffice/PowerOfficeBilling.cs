using System.Globalization;
using System.Net;
using Crm.Billing.Contracts;
using Crm.Catalog.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>
/// Answers what billing needs to know before a run is approved (BR-BIL-03): which customers exist in PowerOffice and which
/// catalog products have a product code there.
/// </summary>
internal sealed class PowerOfficeBillingTarget(
    ExternalLinkService links, ICatalogApi catalog, ExternalRecordStore records, IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeBillingTarget> logger) : IBillingTargetSystem
{
    public string System => PowerOfficeTypes.System;

    // Readiness is checked against links and the catalog — stored data — when crm-web collects a run, and crm-web has no
    // PowerOffice credentials (DEV-04-AC05): the switch decides, the send in crm-worker needs the keys.
    public bool IsConfigured => options.Value.Enabled;

    public async Task<BillingReadiness> CheckAsync(
        IReadOnlyCollection<Guid> organizationIds, IReadOnlyCollection<Guid> productIds, CancellationToken cancellationToken)
    {
        var organizations = await links.LinkedEntitiesAsync(
            EntityTypes.Organization, PowerOfficeTypes.System, PowerOfficeTypes.Customer, organizationIds, cancellationToken);
        var linkedProducts = await links.LinkedEntitiesAsync(
            EntityTypes.Product, PowerOfficeTypes.System, PowerOfficeTypes.Product, productIds, cancellationToken);

        var codes = await PowerOfficeProductCodes.ResolveAsync(linkedProducts, catalog, records, logger, cancellationToken);
        return new BillingReadiness(organizations.Keys.ToHashSet(), codes);
    }
}

/// <summary>An approved basis is queued for PowerOffice, one operation per customer (BR-BIL-06).</summary>
internal sealed class PowerOfficeBasisApprovedHandler(
    OutboundQueue queue, IOptions<PowerOfficeOptions> options, ILogger<PowerOfficeBasisApprovedHandler> logger) : IDomainEventHandler<BillingBasisApproved>
{
    public async Task HandleAsync(BillingBasisApproved domainEvent, CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("Basis {BasisId} not queued: PowerOffice is not configured.", domainEvent.BasisId);
            return;
        }

        await queue.EnqueueAsync(
            PowerOfficeTypes.System, PowerOfficeTypes.CreateSalesOrder, PowerOfficeTypes.BillingBasis, domainEvent.BasisId, null, cancellationToken);
    }
}

/// <summary>
/// Sends one customer's basis to PowerOffice as a sales order (docs/05 §4.3). The basis key travels as the order's external
/// import reference, so a repeated attempt finds the existing order instead of creating a second one (BR-BIL-05). The send is
/// recorded before the request goes out; when an attempt ended without an answer and the lookup does not find the order, the
/// basis waits for reconciliation by a person instead of being sent again (ADR-013).
/// </summary>
internal sealed class PowerOfficeCreateSalesOrderHandler(
    IPowerOfficeClient client,
    IBillingApi billing,
    ExternalLinkService links,
    ICatalogApi catalog,
    IExternalEffectJournal journal,
    ExternalRecordStore records,
    TimeProvider time,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeCreateSalesOrderHandler> logger) : IOutboundHandler
{
    /// <summary>
    /// How long an attempt that got no answer is given before a person is asked: the order may only become searchable a little
    /// after the request, and the outbound queue repeats the lookup on its own backoff meanwhile.
    /// </summary>
    public static readonly TimeSpan UnknownOutcomeGrace = TimeSpan.FromMinutes(10);

    /// <summary>The journal kind of the order request itself, written right before the POST (DEV-13).</summary>
    public const string SalesOrderEffect = "sales-order";

    public string System => PowerOfficeTypes.System;

    public string Operation => PowerOfficeTypes.CreateSalesOrder;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        if (!options.Value.WriteEnabled)
        {
            throw new PermanentOutboundException("Writing to PowerOffice is disabled (Integrations:PowerOffice:WriteEnabled).");
        }

        if (await billing.GetBasisForExportAsync(operation.EntityId, cancellationToken) is not { } basis)
        {
            return OutboundResult.NothingToDo;
        }

        if (basis.Lines.Count == 0)
        {
            await billing.MarkExportFailedAsync(basis.BasisId, System, "The basis has no lines to invoice.", operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException("The basis has no lines to invoice.");
        }

        var customerLink = await links.FindByEntityAsync(EntityTypes.Organization, basis.OrganizationId, System, PowerOfficeTypes.Customer, cancellationToken);
        if (customerLink is null)
        {
            const string message = "The customer is not linked to a PowerOffice customer.";
            await billing.MarkExportFailedAsync(basis.BasisId, System, message, operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException(message);
        }

        var existing = await client.FindSalesOrderAsync(basis.IdempotencyKey, cancellationToken);
        if (existing is not null)
        {
            await billing.MarkExportedAsync(basis.BasisId, System, existing.Number, operation.Id.ToString(), cancellationToken);
            return new OutboundResult($"Order {existing.Number} already existed.", existing.Number);
        }

        if (basis.SendStarted)
        {
            // An earlier attempt may have created the order and the lookup does not show it: sending again could invoice twice.
            // Shortly after the attempt that is the likelier explanation than a lost request, so the lookup is repeated by the
            // outbound retry first; the send marker stays and nothing is sent. A basis whose marker has no time is old data.
            if (basis.SendStartedAt is { } startedAt && time.GetUtcNow() - startedAt < UnknownOutcomeGrace)
            {
                logger.LogInformation("Sales order for basis {BasisId} not found yet; the earlier send is less than {Grace} old, looking again on the next attempt.",
                    basis.BasisId, UnknownOutcomeGrace);
                throw new SalesOrderOutcomeUnknownException(basis.IdempotencyKey);
            }

            var message = $"An earlier send got no answer and no order with reference {basis.IdempotencyKey} was found; check PowerOffice and reconcile the basis.";
            await billing.MarkReconciliationRequiredAsync(basis.BasisId, System, message, operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException(message);
        }

        // DEV-13: the database may have been restored to a point before an earlier send, which forgets the send marker above.
        // The external effect journal lies outside the database and still knows: an order request that was sent — or got no
        // answer — sends nothing more; the basis waits for Finance with the order number when PowerOffice reported one.
        // Attempts Finance settled since, by checking PowerOffice and reconciling the basis, count no more.
        var earlier = (await journal.ForEntityAsync(PowerOfficeTypes.BillingBasis, basis.BasisId, cancellationToken))
            .Where(e => e.System == System && e.Kind == SalesOrderEffect && (basis.CheckedAt is not { } checkedAt || e.At > checkedAt))
            .ToList();
        if (ExternalEffects.MayExist(earlier))
        {
            var reference = ExternalEffects.LatestReference(earlier);
            var at = earlier.Max(e => e.At).ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture);
            var message = reference is null
                ? $"An order request for this basis was sent at {at} and got no answer (external effect journal); check PowerOffice for reference {basis.IdempotencyKey} and reconcile the basis."
                : $"PowerOffice created order {reference} for this basis at {at} (external effect journal), which this database does not know; check it and reconcile the basis.";
            await billing.MarkReconciliationRequiredAsync(basis.BasisId, System, message, operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException(message);
        }

        var codes = await ProductCodesAsync(basis, cancellationToken);
        var missing = basis.Lines.Where(l => l.ProductId is { } id && !codes.ContainsKey(id)).Select(l => l.Description).Distinct().ToList();
        if (missing.Count > 0)
        {
            var message = $"No PowerOffice product for: {string.Join(", ", missing.Take(3))}.";
            await billing.MarkExportFailedAsync(basis.BasisId, System, message, operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException(message);
        }

        // Journaled before the send is marked: when the journal cannot take the entry, nothing is marked and nothing is sent.
        // Alone, the entry tells a restore that this order may exist (DEV-13).
        var effect = await journal.BeginAsync(
            new ExternalEffect(System, SalesOrderEffect, PowerOfficeTypes.BillingBasis, basis.BasisId, operation.Id), cancellationToken);

        // From here on an unknown outcome means the order may exist; a basis cancelled meanwhile is not sent at all.
        if (!await billing.MarkExportSendingAsync(basis.BasisId, System, operation.Id.ToString(), cancellationToken))
        {
            await journal.CompleteAsync(effect, EffectPhase.Skipped, null, cancellationToken);
            return OutboundResult.NothingToDo;
        }

        PoSalesOrder order;
        try
        {
            order = await client.CreateSalesOrderAsync(new PoSalesOrderPost(
                long.Parse(customerLink.ExternalId, CultureInfo.InvariantCulture),
                new DateTimeOffset(basis.PeriodEnd.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero),
                basis.IdempotencyKey,
                basis.CustomerReference,
                basis.Lines.Select((line, index) => new PoSalesOrderLinePost(
                    line.ProductId is { } productId ? codes[productId] : line.ProductCode,
                    line.Description,
                    line.Quantity,
                    line.UnitPrice,
                    line.DiscountPct == 0 ? null : line.DiscountPct,
                    index + 1)).ToList()), cancellationToken);
        }
        catch (PowerOfficeApiException rejected) when (IsRejection(rejected.Status))
        {
            // PowerOffice answered and refused the order: nothing was created, the basis can be fixed and sent again.
            await journal.CompleteAsync(effect, EffectPhase.Failed, null, cancellationToken);
            var message = $"PowerOffice rejected the order: {rejected.Message}";
            await billing.MarkExportFailedAsync(basis.BasisId, System, message, operation.Id.ToString(), cancellationToken);
            throw new PermanentOutboundException(message);
        }

        await journal.CompleteAsync(effect, EffectPhase.Sent, order.Number, cancellationToken);
        await billing.MarkExportedAsync(basis.BasisId, System, order.Number, operation.Id.ToString(), cancellationToken);
        return new OutboundResult($"Created sales order {order.Number} for {basis.Lines.Count} lines.", order.Number);
    }

    /// <summary>
    /// A refusal PowerOffice answered with, so no order exists. Timeouts, conflicts, throttling and server errors are not:
    /// the order may have been created, and the next attempt looks it up before anything else (ADR-013).
    /// </summary>
    internal static bool IsRejection(HttpStatusCode status) =>
        (int)status is >= 400 and < 500 && status is not (HttpStatusCode.RequestTimeout or HttpStatusCode.Conflict or HttpStatusCode.TooManyRequests);

    private async Task<IReadOnlyDictionary<Guid, string>> ProductCodesAsync(ExportBasis basis, CancellationToken cancellationToken)
    {
        var productIds = basis.Lines.Where(l => l.ProductId is not null).Select(l => l.ProductId!.Value).Distinct().ToList();
        var linked = await links.LinkedEntitiesAsync(EntityTypes.Product, System, PowerOfficeTypes.Product, productIds, cancellationToken);
        return await PowerOfficeProductCodes.ResolveAsync(linked, catalog, records, logger, cancellationToken);
    }
}

/// <summary>
/// The send did not get an answer and the order is not found yet. Not permanent: the outbound queue tries again, and the lookup
/// by reference comes first every time. The message carries the reference only.
/// </summary>
internal sealed class SalesOrderOutcomeUnknownException(string reference)
    : Exception($"The outcome of the earlier send is unknown; no order with reference {reference} found yet.");

/// <summary>
/// The product code an order line carries is the one PowerOffice has on the linked product record, not the CRM SKU as it is
/// today: renaming a SKU must not silently change what is invoiced. Without a stored record the SKU is used, as by convention
/// (docs/05 §4.2); a record that is archived in Go is not a product to bill.
/// </summary>
internal static class PowerOfficeProductCodes
{
    public static async Task<Dictionary<Guid, string>> ResolveAsync(
        IReadOnlyDictionary<Guid, string> linkedProducts, ICatalogApi catalog, ExternalRecordStore records, ILogger logger, CancellationToken cancellationToken)
    {
        var products = await catalog.GetProductsAsync(linkedProducts.Keys.ToList(), cancellationToken);
        var codes = new Dictionary<Guid, string>();
        foreach (var (productId, externalId) in linkedProducts)
        {
            if (!products.TryGetValue(productId, out var product))
            {
                continue;
            }

            var record = await records.FindAsync(PowerOfficeTypes.System, PowerOfficeTypes.Product, externalId, cancellationToken);
            if (record is null)
            {
                codes[productId] = product.Sku;
                continue;
            }

            if (record.IsGone)
            {
                continue;
            }

            var code = ExternalRecordStore.Read<PoProduct>(record)?.Code;
            if (string.IsNullOrWhiteSpace(code))
            {
                codes[productId] = product.Sku;
                continue;
            }

            if (!string.Equals(code, product.Sku, StringComparison.Ordinal))
            {
                logger.LogWarning("CRM product {ProductId} has SKU that differs from the code of its linked PowerOffice product {ExternalId}; the PowerOffice code is used.", productId, externalId);
            }

            codes[productId] = code;
        }

        return codes;
    }
}

/// <summary>
/// Mirrors outgoing invoices and their remaining amount back into the CRM (docs/05 §4.2), so a customer's balance sits next to
/// their contracts. Payments are derived from the remaining amount going down; a ledger API would give them directly (R2).
/// </summary>
public sealed class PowerOfficeInvoiceSyncJob(
    IPowerOfficeClient client,
    IBillingApi billing,
    SyncRunner runner,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeInvoiceSyncJob> logger)
{
    public const string JobId = "poweroffice-invoices";
    private const string Stream = "invoices";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("PowerOffice invoice sync skipped: integration not configured.");
            return;
        }

        await runner.RunExclusiveAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var since = PowerOfficeCursor.Parse(await runner.GetCursorAsync(PowerOfficeTypes.System, Stream, ct));
            var newest = since;
            var invoices = new List<ExternalInvoice>();
            await foreach (var invoice in client.GetOutgoingInvoicesAsync(PowerOfficeCursor.ReadFrom(since), ct))
            {
                progress.Read++;
                if (invoice.LastChangedDateTimeOffset is { } changed && (newest is null || changed > newest))
                {
                    newest = changed;
                }

                if (Map(invoice) is { } mapped)
                {
                    invoices.Add(mapped);
                }
            }

            var result = await billing.UpsertInvoicesAsync(invoices, ct);
            progress.Changed = result.Created + result.Updated;
            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, PowerOfficeCursor.Format(newest), ct);
            progress.Message = $"created {result.Created}, updated {result.Updated}, without a basis {result.Unmatched}";
        }, cancellationToken);
    }

    /// <summary>Fields are read defensively: an invoice without a number or date is not something the CRM can mirror.</summary>
    internal static ExternalInvoice? Map(PoOutgoingInvoice invoice)
    {
        if (string.IsNullOrWhiteSpace(invoice.InvoiceNo) || invoice.InvoiceDate is not { } invoiceDate)
        {
            return null;
        }

        var total = invoice.TotalAmount ?? 0m;
        var outstanding = invoice.RemainingAmount ?? total;
        return new ExternalInvoice(
            PowerOfficeTypes.System,
            invoice.InvoiceNo!,
            invoice.OrderNo?.ToString(CultureInfo.InvariantCulture),
            invoice.ExternalImportReference,
            null,
            DateOnly.FromDateTime(invoiceDate.Date),
            invoice.DueDate is { } due ? DateOnly.FromDateTime(due.Date) : null,
            total,
            outstanding,
            StatusOf(invoice, total, outstanding),
            invoice.PdfUrl);
    }

    private static InvoiceStatus StatusOf(PoOutgoingInvoice invoice, decimal total, decimal outstanding) =>
        invoice.IsCredited == true || string.Equals(invoice.Status, "Credited", StringComparison.OrdinalIgnoreCase) ? InvoiceStatus.Credited
        : outstanding <= 0 ? InvoiceStatus.Paid
        : outstanding < total ? InvoiceStatus.PartiallyPaid
        : string.Equals(invoice.Status, "Draft", StringComparison.OrdinalIgnoreCase) ? InvoiceStatus.Draft
        : InvoiceStatus.Sent;
}
