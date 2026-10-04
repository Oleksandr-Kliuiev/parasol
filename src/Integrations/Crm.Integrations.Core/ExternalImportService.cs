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

        return await ImportAsync(resolved.Adapter, resolved.Descriptor, record, cancellationToken);
    }

    public async Task<Result<BulkResult>> AutoLinkAsync(string system, string type, CancellationToken cancellationToken)
    {
        if (Resolve(system, type) is not { } resolved)
        {
            return NotConfigured(system, type);
        }

        int linked = 0, skipped = 0, failed = 0;
        var errors = new List<string>();
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

        return new BulkResult(linked, 0, skipped, failed, errors, DryRun: false);

        async Task LinkOrCountAsync(ExternalTypeDescriptor descriptor, ExternalRecord record, Guid entityId, LinkMethod method)
        {
            var result = await links.LinkAsync(descriptor.EntityType, entityId, record.System, record.ExternalType, record.ExternalId, method, user.UserId, cancellationToken);
            if (result.IsSuccess)
            {
                linked++;
            }
            else
            {
                skipped++;
                if (errors.Count < 50)
                {
                    errors.Add($"{record.DisplayName}: {result.Error!.Message}");
                }
            }
        }
    }

    /// <summary>Imports every unlinked record. With <paramref name="dryRun"/> nothing is written and the counts show what would happen.</summary>
    public async Task<Result<BulkResult>> ImportUnlinkedAsync(string system, string type, bool dryRun, CancellationToken cancellationToken)
    {
        if (Resolve(system, type) is not { } resolved)
        {
            return NotConfigured(system, type);
        }

        var unlinked = await UnlinkedAsync(system, type, cancellationToken);
        int created = 0, linked = 0, skipped = 0, failed = 0;
        var errors = new List<string>();
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
                        var link = await links.LinkAsync(EntityTypes.Organization, exact.OrganizationId, record.System, record.ExternalType, record.ExternalId,
                            LinkMethod.Automatic, user.UserId, cancellationToken);
                        if (!link.IsSuccess)
                        {
                            skipped++;
                            continue;
                        }
                    }

                    linked++;
                    continue;
                }

                if (dryRun)
                {
                    created++;
                    continue;
                }
            }
            else if (dryRun)
            {
                created++;
                continue;
            }

            var result = await ImportAsync(resolved.Adapter, resolved.Descriptor, record, cancellationToken);
            if (result.IsSuccess)
            {
                created++;
            }
            else if (result.Error!.Code == "INT_PARENT_NOT_LINKED")
            {
                skipped++;
            }
            else
            {
                failed++;
                if (errors.Count < 50)
                {
                    errors.Add($"{record.DisplayName}: {result.Error.Message}");
                }
            }
        }

        return new BulkResult(linked, created, skipped, failed, errors, dryRun);
    }

    private async Task<Result<Guid>> ImportAsync(IIntegrationAdapter adapter, ExternalTypeDescriptor descriptor, ExternalRecord record, CancellationToken cancellationToken)
    {
        try
        {
            Guid entityId;
            LinkMethod method;
            if (descriptor.EntityType == EntityTypes.Organization)
            {
                var data = adapter.ToOrganizationData(record)
                           ?? throw new InvalidOperationException("The record cannot be read as an organization.");
                var imported = await customers.ImportOrganizationAsync(data, OrganizationStatus.Customer, cancellationToken);
                entityId = imported.OrganizationId;
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
                var imported = await customers.ImportContactAsync(parent.EntityId, data, cancellationToken);
                entityId = imported.ContactId;
                method = imported.Created ? LinkMethod.Imported : LinkMethod.Automatic;
            }
            else if (descriptor.EntityType == EntityTypes.Product)
            {
                var data = adapter.ToProductData(record) ?? throw new InvalidOperationException("The record cannot be read as a product.");
                var imported = await catalog.ImportProductAsync(data, cancellationToken);
                entityId = imported.ProductId;
                method = imported.Created ? LinkMethod.Imported : LinkMethod.Automatic;
            }
            else
            {
                return Error.Validation("INT_IMPORT_UNSUPPORTED", $"Records of type {descriptor.ExternalType} cannot be imported.");
            }

            var link = await links.LinkAsync(descriptor.EntityType, entityId, record.System, record.ExternalType, record.ExternalId, method, user.UserId, cancellationToken);
            return link.IsSuccess ? entityId : link.Error!;
        }
        catch (InvalidOperationException ex)
        {
            return Error.Validation("INT_IMPORT_FAILED", ex.Message);
        }
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
