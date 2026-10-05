using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;
using Crm.Privacy.Contracts;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core;

/// <summary>
/// Creates CRM records from external ones and links them. Also the first-load migration (docs/01 §6.6): automatic links by
/// org number / e-mail first, then import of the rest; ambiguous cases stay in the mapping queue.
/// </summary>
public sealed class ExternalImportService(
    IEnumerable<IIntegrationAdapter> adapters,
    IntegrationDbContext db,
    ExternalLinkService links,
    ICustomersApi customers,
    ICatalogApi catalog,
    ICurrentUser user,
    ISuppressionList suppressions)
{
    public async Task<Result<Guid>> ImportOneAsync(string system, string type, string externalId, CancellationToken cancellationToken)
    {
        if (Resolve(system, type) is not { } resolved)
        {
            return NotConfigured(system, type);
        }

        var record = await db.ExternalRecords.AsNoTracking()
            .SingleOrDefaultAsync(r => r.System == system && r.ExternalType == type && r.ExternalId == externalId, cancellationToken);
        if (record is null)
        {
            return Error.NotFound("INT_RECORD_NOT_FOUND", $"External record {system}/{type}/{externalId} was not found.");
        }

        if (await links.FindByExternalAsync(system, type, externalId, cancellationToken) is { } existing)
        {
            return existing.EntityId;
        }

        var imported = await ImportAsync(resolved.Adapter, resolved.Descriptor, record, dryRun: false, cancellationToken);
        return imported.IsSuccess ? imported.Value.EntityId : imported.Error!;
    }

    public async Task<Result<BulkResult>> AutoLinkAsync(string system, string type, CancellationToken cancellationToken)
    {
        if (Resolve(system, type) is not { } resolved)
        {
            return NotConfigured(system, type);
        }

        int linked = 0, skipped = 0, failed = 0;
        var errors = new List<string>();
        var failures = new Dictionary<string, int>(StringComparer.Ordinal);
        var unlinked = await UnlinkedAsync(system, type, cancellationToken);

        if (resolved.Descriptor.EntityType == EntityTypes.Organization)
        {
            var matcher = await customers.CreateMatcherAsync(cancellationToken);
            foreach (var record in unlinked)
            {
                var matches = resolved.Adapter.ToOrganizationData(record) is { } data ? matcher.Match(data) : [];
                if (matches is [{ IsExact: true } only])
                {
                    await LinkOrCountAsync(resolved.Descriptor, record, only.OrganizationId, LinkMethod.Automatic);
                }
                else
                {
                    skipped++;
                }
            }
        }
        else if (resolved.Descriptor.EntityType == EntityTypes.Contact)
        {
            var byEmail = await customers.FindContactsByEmailAsync(unlinked.Where(r => r.Email != null).Select(r => r.Email!).ToList(), cancellationToken);
            foreach (var record in unlinked)
            {
                if (record.Email is not null && byEmail.TryGetValue(record.Email, out var contactId))
                {
                    await LinkOrCountAsync(resolved.Descriptor, record, contactId, LinkMethod.Automatic);
                }
                else
                {
                    skipped++;
                }
            }
        }
        else if (resolved.Descriptor.EntityType == EntityTypes.Product)
        {
            var codes = unlinked.Select(r => resolved.Adapter.ToProductData(r)?.Code).OfType<string>().ToList();
            var bySku = await catalog.FindProductsBySkuAsync(codes, cancellationToken);
            foreach (var record in unlinked)
            {
                if (resolved.Adapter.ToProductData(record)?.Code is { } code && bySku.TryGetValue(code.Trim(), out var productId))
                {
                    await LinkOrCountAsync(resolved.Descriptor, record, productId, LinkMethod.Automatic);
                }
                else
                {
                    skipped++;
                }
            }
        }
        else
        {
            skipped = unlinked.Count;
        }

        return new BulkResult(linked, 0, skipped, failed, WithSummary(errors, failures), DryRun: false);

        async Task LinkOrCountAsync(ExternalTypeDescriptor descriptor, ExternalRecord record, Guid entityId, LinkMethod method)
        {
            var result = await TryLinkAsync(descriptor, record, entityId, method, cancellationToken);
            if (result.IsSuccess)
            {
                linked++;
            }
            else
            {
                // A link that could not be made is a failure to look at, not a record that was merely passed over.
                failed++;
                Note(errors, failures, record, result.Error!.Code);
            }
        }
    }

    /// <summary>
    /// Imports every unlinked record. With <paramref name="dryRun"/> nothing is written and the counts are exactly what the real
    /// run reports: both walk the same decisions (a parent that is not linked is skipped, an erased person fails, "created"
    /// means a new record was really made, a match is "linked"). Errors name the record by its external id and a code, never by
    /// a person's or a company's name.
    /// </summary>
    public async Task<Result<BulkResult>> ImportUnlinkedAsync(string system, string type, bool dryRun, CancellationToken cancellationToken)
    {
        if (Resolve(system, type) is not { } resolved)
        {
            return NotConfigured(system, type);
        }

        var unlinked = await UnlinkedAsync(system, type, cancellationToken);
        int created = 0, linked = 0, skipped = 0, failed = 0;
        var errors = new List<string>();
        var codes = new Dictionary<string, int>(StringComparer.Ordinal);
        IOrganizationMatcher? matcher = resolved.Descriptor.EntityType == EntityTypes.Organization ? await customers.CreateMatcherAsync(cancellationToken) : null;

        foreach (var record in unlinked)
        {
            if (resolved.Descriptor.EntityType == EntityTypes.Organization)
            {
                var data = resolved.Adapter.ToOrganizationData(record);
                var matches = data is null ? [] : matcher!.Match(data);
                // Possible duplicates without an org number match need a human decision.
                if (data is null || (matches.Count > 0 && !matches.Any(m => m.IsExact)))
                {
                    skipped++;
                    continue;
                }

                if (matches.FirstOrDefault(m => m.IsExact) is { } exact)
                {
                    if (!dryRun)
                    {
                        var link = await TryLinkAsync(resolved.Descriptor, record, exact.OrganizationId, LinkMethod.Automatic, cancellationToken);
                        if (!link.IsSuccess)
                        {
                            failed++;
                            Note(errors, codes, record, link.Error!.Code);
                            continue;
                        }
                    }

                    linked++;
                    continue;
                }
            }

            var result = await ImportAsync(resolved.Adapter, resolved.Descriptor, record, dryRun, cancellationToken);
            if (result.IsSuccess)
            {
                if (result.Value.Created)
                {
                    created++;
                }
                else
                {
                    linked++;
                }
            }
            else if (result.Error!.Code == "INT_PARENT_NOT_LINKED")
            {
                skipped++;
            }
            else
            {
                failed++;
                Note(errors, codes, record, result.Error.Code);
            }
        }

        return new BulkResult(linked, created, skipped, failed, WithSummary(errors, codes), dryRun);
    }

    private sealed record Imported(Guid EntityId, bool Created);

    /// <summary>
    /// The decisions of an import, one record. A dry run takes every one of them, reading only, and stops short of the write:
    /// whatever would make the real run skip or fail the record makes the preview say so.
    /// </summary>
    private async Task<Result<Imported>> ImportAsync(
        IIntegrationAdapter adapter, ExternalTypeDescriptor descriptor, ExternalRecord record, bool dryRun, CancellationToken cancellationToken)
    {
        try
        {
            Guid entityId;
            LinkMethod method;
            bool wasCreated;
            if (descriptor.EntityType == EntityTypes.Organization)
            {
                var data = adapter.ToOrganizationData(record)
                           ?? throw new InvalidOperationException("The record cannot be read as an organization.");
                if (string.IsNullOrWhiteSpace(data.Name))
                {
                    throw new InvalidOperationException("The record has no name.");
                }

                if (dryRun)
                {
                    return new Imported(Guid.Empty, Created: true);
                }

                var imported = await customers.ImportOrganizationAsync(data, OrganizationStatus.Customer, cancellationToken);
                entityId = imported.OrganizationId;
                wasCreated = imported.Created;
                method = imported.Created ? LinkMethod.Imported : LinkMethod.Automatic;
            }
            else if (descriptor.EntityType == EntityTypes.Contact)
            {
                // DEV-11-AC05: a person erased at their request comes back only with a new lawful basis — their suppression
                // lifted on the privacy page — never with an import.
                if (await suppressions.IsSuppressedAsync(record.Email, new ExternalReference(record.System, record.ExternalType, record.ExternalId), cancellationToken))
                {
                    return Error.Conflict("PRV_SUPPRESSED", "This person was erased at their request and is not imported again without a new lawful basis.");
                }

                var parentType = descriptor.ParentExternalType
                                 ?? throw new InvalidOperationException("Contact record type has no parent type.");
                if (record.ParentExternalId is null ||
                    await links.FindByExternalAsync(record.System, parentType, record.ParentExternalId, cancellationToken) is not { } parent)
                {
                    return Error.Validation("INT_PARENT_NOT_LINKED", "Link or import the contact's customer first.");
                }

                var data = adapter.ToContactData(record) ?? throw new InvalidOperationException("The record cannot be read as a contact.");
                if (dryRun)
                {
                    // The import matches a person by a valid address; without one it makes a new contact.
                    var address = data.Email?.Trim();
                    var matchable = address is { Length: > 0 } && System.Net.Mail.MailAddress.TryCreate(address, out _);
                    var existing = matchable ? await customers.FindContactsByEmailAsync([address!], cancellationToken) : new Dictionary<string, Guid>();
                    return new Imported(Guid.Empty, Created: !matchable || !existing.ContainsKey(address!.ToLowerInvariant()));
                }

                var imported = await customers.ImportContactAsync(parent.EntityId, data, cancellationToken);
                entityId = imported.ContactId;
                wasCreated = imported.Created;
                method = imported.Created ? LinkMethod.Imported : LinkMethod.Automatic;
            }
            else if (descriptor.EntityType == EntityTypes.Product)
            {
                var data = adapter.ToProductData(record) ?? throw new InvalidOperationException("The record cannot be read as a product.");
                if (dryRun)
                {
                    var code = string.IsNullOrWhiteSpace(data.Code) ? data.Name : data.Code;
                    var sku = code.Trim();
                    var existing = await catalog.FindProductsBySkuAsync([sku.Length > 64 ? sku[..64] : sku], cancellationToken);
                    return new Imported(Guid.Empty, Created: existing.Count == 0);
                }

                var imported = await catalog.ImportProductAsync(data, cancellationToken);
                entityId = imported.ProductId;
                wasCreated = imported.Created;
                method = imported.Created ? LinkMethod.Imported : LinkMethod.Automatic;
            }
            else
            {
                return Error.Validation("INT_IMPORT_UNSUPPORTED", $"Records of type {descriptor.ExternalType} cannot be imported.");
            }

            var link = await TryLinkAsync(descriptor, record, entityId, method, cancellationToken);
            return link.IsSuccess ? new Imported(entityId, wasCreated) : link.Error!;
        }
        catch (InvalidOperationException)
        {
            // The message of an exception from a module can carry the name of the record; the code is all that is passed on.
            return Error.Validation("INT_IMPORT_FAILED", "The record cannot be imported.");
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            return new Error("INT_IMPORT_DB_FAILED", "The record could not be saved.", ErrorType.Failure);
        }
    }

    /// <summary>Links, and a link the database refuses is a failure of this record, not of the whole run.</summary>
    private async Task<Result<Guid>> TryLinkAsync(
        ExternalTypeDescriptor descriptor, ExternalRecord record, Guid entityId, LinkMethod method, CancellationToken cancellationToken)
    {
        try
        {
            var link = await links.LinkAsync(descriptor.EntityType, entityId, record.System, record.ExternalType, record.ExternalId, method, user.UserId, cancellationToken);
            return link.IsSuccess ? entityId : link.Error!;
        }
        catch (DbUpdateException)
        {
            db.ChangeTracker.Clear();
            return new Error("INT_IMPORT_DB_FAILED", "The link could not be saved.", ErrorType.Failure);
        }
    }

    private static void Note(List<string> errors, Dictionary<string, int> codes, ExternalRecord record, string code)
    {
        codes[code] = codes.GetValueOrDefault(code) + 1;
        if (errors.Count < 50)
        {
            errors.Add($"{record.ExternalType}/{record.ExternalId}: {code}");
        }
    }

    /// <summary>The listed errors are capped; the last line counts every code, so a long failure list does not look like a short one.</summary>
    private static List<string> WithSummary(List<string> errors, Dictionary<string, int> codes)
    {
        if (codes.Count > 0)
        {
            errors.Add("Summary: " + string.Join(", ", codes.OrderBy(c => c.Key, StringComparer.Ordinal).Select(c => $"{c.Key}={c.Value}")));
        }

        return errors;
    }

    private async Task<List<ExternalRecord>> UnlinkedAsync(string system, string type, CancellationToken cancellationToken)
    {
        var linkedIds = db.ExternalLinks.Where(l => l.System == system && l.ExternalType == type).Select(l => l.ExternalId);
        return await db.ExternalRecords.AsNoTracking()
            .Where(r => r.System == system && r.ExternalType == type && !r.IsGone && !linkedIds.Contains(r.ExternalId))
            .OrderBy(r => r.DisplayName)
            .ToListAsync(cancellationToken);
    }

    private (IIntegrationAdapter Adapter, ExternalTypeDescriptor Descriptor)? Resolve(string system, string type)
    {
        var adapter = adapters.SingleOrDefault(a => a.System == system);
        var descriptor = adapter?.RecordTypes.SingleOrDefault(t => t.ExternalType == type);
        return adapter is null || descriptor is null ? null : (adapter, descriptor);
    }

    private static Error NotConfigured(string system, string type) =>
        Error.NotFound("INT_NOT_FOUND", $"'{system}/{type}' is not a known record type.");
}
