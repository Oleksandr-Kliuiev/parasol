using System.Data;
using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Explicit, atomic migration into the existing CRM link registry. No provider calls or customer creation.</summary>
public sealed class CustomerIdentityService(
    IntegrationDbContext db, ExternalRecordStore records, ExternalLinkService links, ICustomersApi customers,
    ICurrentUser user, IRequestContext request, TimeProvider time)
{
    public async Task<Result<CustomerIdentityPlan>> ImportAsync(CustomerIdentityImport input, bool dryRun, string? expectedSha256, CancellationToken ct)
    {
        if (CustomerIdentityContract.Validate(input) is { } invalid) return invalid;
        var hash = CustomerIdentityContract.PlanHash(input);
        if (!dryRun && !string.Equals(hash, expectedSha256, StringComparison.Ordinal))
            return Error.PreconditionFailed("PARASOL_IDENTITY_PLAN_CHANGED", "Preview the exact input and confirm its SHA-256 before applying it.");
        if (!dryRun && user.UserId is null)
            return Error.Forbidden("PARASOL_IDENTITY_ACTOR_REQUIRED", "An authenticated employee must confirm the mapping.");

        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            // This service owns this request's integration unit of work. A SQL retry must not retain rolled-back rows.
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
            await LockAsync(ct);
            var existing = await db.ExternalLinks.AsNoTracking()
                .Where(l => l.System == CustomerIdentityContract.System && l.ExternalType == CustomerIdentityContract.ExternalType).ToListAsync(ct);
            var rows = new List<CustomerIdentityPlanRow>();
            foreach (var m in input.Mappings.OrderBy(m => m.AtlasClientId, StringComparer.Ordinal))
            {
                var key = CustomerIdentityContract.ExternalId(input.Snapshot.WorkspaceId, m.AtlasClientId);
                var external = existing.SingleOrDefault(l => l.ExternalId == key);
                var customer = existing.SingleOrDefault(l => l.EntityType == EntityTypes.Organization && l.EntityId == m.CustomerId);
                var outcome = await customers.GetOrganizationAsync(m.CustomerId, ct) is null ? "CUSTOMER_UNAVAILABLE"
                    : external is not null && (external.EntityType != EntityTypes.Organization || external.EntityId != m.CustomerId) ? "ATLAS_ALREADY_LINKED"
                    : customer is not null && customer.ExternalId != key ? "CUSTOMER_ALREADY_LINKED"
                    : external is not null ? "ALREADY_LINKED" : "READY";
                if (outcome == "ALREADY_LINKED" && await ReadReferenceAsync(external!, ct) is null) outcome = "IDENTITY_INCONSISTENT";
                rows.Add(new(m.AtlasClientId, m.CustomerId, outcome));
            }
            var canApply = rows.All(r => r.Outcome is "READY" or "ALREADY_LINKED");
            var plan = new CustomerIdentityPlan(hash, dryRun, canApply, input.Snapshot.Clients.Count - input.Mappings.Count, rows);
            if (dryRun) return Result<CustomerIdentityPlan>.Success(plan); // Dispose rolls back; a preview writes nothing.
            if (!canApply) return Result<CustomerIdentityPlan>.Failure(Error.Conflict("PARASOL_IDENTITY_CONFLICT", "No mappings were applied. Resolve conflicts and preview again.",
                new Dictionary<string, object?> { ["rows"] = rows }));

            foreach (var row in rows.Where(r => r.Outcome == "READY"))
            {
                var source = input.Snapshot.Clients.Single(c => c.ClientId == row.AtlasClientId);
                var reference = new AtlasCustomerReference(input.Snapshot.WorkspaceId, row.AtlasClientId);
                var key = CustomerIdentityContract.ExternalId(reference.WorkspaceId, reference.ClientId);
                await records.UpsertAsync(new(CustomerIdentityContract.System, CustomerIdentityContract.ExternalType, key, source.Name, reference), ct);
                var linked = await links.LinkAsync(EntityTypes.Organization, row.CustomerId, CustomerIdentityContract.System,
                    CustomerIdentityContract.ExternalType, key, LinkMethod.Manual, user.UserId, ct);
                if (!linked.IsSuccess) return Result<CustomerIdentityPlan>.Failure(linked.Error!);
                // IDs/hash only: names, source payloads and credentials are not duplicated into the audit details.
                db.RecordAudit(user, request, time, "ParasolIdentityLinked", EntityTypes.Organization, row.CustomerId,
                    new { planSha256 = hash, externalLinkId = linked.Value.Id });
            }
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Result<CustomerIdentityPlan>.Success(plan with
            {
                Rows = rows.Select(r => r.Outcome == "READY" ? r with { Outcome = "APPLIED" } : r).ToArray(),
            });
        });
    }

    public async Task<Result<CustomerIdentityView>> GetAsync(Guid customerId, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(customerId, ct) is null)
            return Error.NotFound("PARASOL_CUSTOMER_NOT_FOUND", "The customer is unavailable.");
        var link = await links.FindByEntityAsync(EntityTypes.Organization, customerId, CustomerIdentityContract.System, CustomerIdentityContract.ExternalType, ct);
        if (link is null) return new CustomerIdentityView(customerId, null);
        var reference = await ReadReferenceAsync(link, ct);
        if (reference is null) return Error.Conflict("PARASOL_IDENTITY_INCONSISTENT", "The stored identity needs review.");
        return new CustomerIdentityView(customerId, reference);
    }

    private async Task<AtlasCustomerReference?> ReadReferenceAsync(ExternalLink link, CancellationToken ct)
    {
        var record = await records.FindAsync(link.System, link.ExternalType, link.ExternalId, ct);
        AtlasCustomerReference? reference = null;
        try { if (record is not null) reference = ExternalRecordStore.Read<AtlasCustomerReference>(record); }
        catch (JsonException) { /* An inconsistent registry never produces a trusted reference. */ }
        if (reference is null || string.IsNullOrEmpty(reference.WorkspaceId) || string.IsNullOrEmpty(reference.ClientId)
            || CustomerIdentityContract.ExternalId(reference.WorkspaceId, reference.ClientId) != link.ExternalId)
            return null;
        return reference;
    }

    /// <summary>Correction uses the exact existing link ID and the same lock as import; deletion and audit commit together.</summary>
    public async Task<Result<bool>> UnlinkAsync(Guid linkId, CancellationToken ct)
    {
        if (user.UserId is null) return Error.Forbidden("PARASOL_IDENTITY_ACTOR_REQUIRED", "An authenticated employee must confirm the mapping.");
        return await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            db.ChangeTracker.Clear();
            await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
            await LockAsync(ct);
            var link = await db.ExternalLinks.SingleOrDefaultAsync(l => l.Id == linkId && l.System == CustomerIdentityContract.System
                && l.ExternalType == CustomerIdentityContract.ExternalType && l.EntityType == EntityTypes.Organization, ct);
            if (link is null) return Result<bool>.Success(false);
            db.ExternalLinks.Remove(link);
            db.RecordAudit(user, request, time, "ParasolIdentityUnlinked", EntityTypes.Organization, link.EntityId, new { externalLinkId = link.Id });
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
            return Result<bool>.Success(true);
        });
    }

    private Task<int> LockAsync(CancellationToken ct) => db.Database.ExecuteSqlRawAsync(
        "DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource=N'parasol-customer-identity', @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=10000; IF @r < 0 THROW 51000, 'Customer identity import is busy.', 1;", ct);
}
