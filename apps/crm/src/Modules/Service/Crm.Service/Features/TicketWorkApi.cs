using System.Data;
using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Service.Contracts;
using Crm.Service.Domain;
using Crm.Service.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Crm.Service.Features;

internal sealed class TicketWorkApi(DbContextOptions<ServiceDbContext> options,
    IOrganizationWorkLease customers, ITicketOwnershipApi owners) : ITicketWorkApi
{
    private static Error Unavailable => Error.NotFound("SRV_WORK_TICKET_UNAVAILABLE", "The saved ticket is unavailable for this customer.");

    public Task<Result<TicketWorkRef>> GetAsync(Guid organizationId, Guid ticketId, CancellationToken cancellationToken) =>
        WithCurrentAsync<TicketWorkRef>(organizationId, ticketId, (ticket, _) => Task.FromResult<Result<TicketWorkRef>>(ticket), cancellationToken);

    public Task<Result<T>> WithCurrentAsync<T>(Guid organizationId, Guid ticketId,
        Func<TicketWorkRef, CancellationToken, Task<Result<T>>> action, CancellationToken cancellationToken) =>
        customers.WithUsableAsync(organizationId, (_, ct) => owners.WithCurrentAsync<T>(organizationId, async (binding, ownerCt) =>
        {
            if (binding is null) return Unavailable;
            await using var db = CreateReadContext();
            await using var lease = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ownerCt);
            var ticket = await Eligible(db, binding).SingleOrDefaultAsync(row => row.Id == ticketId, ownerCt);
            if (ticket is null) return Unavailable;
            var result = await action(ToRef(ticket), ownerCt);
            await lease.CommitAsync(ownerCt);
            return result;
        }, ct), cancellationToken);

    public Task<Result<PagedResult<TicketWorkRef>>> ListAsync(Guid organizationId, int? limit, string? cursor, CancellationToken cancellationToken) =>
        customers.WithUsableAsync(organizationId, (_, ct) => owners.WithCurrentAsync<PagedResult<TicketWorkRef>>(organizationId, async (binding, ownerCt) =>
        {
            var after = KeysetCursor.Decode(cursor);
            var scope = binding is null ? null : $"{organizationId:N}:{binding.LinkId:N}:{binding.CustomerId.ToString(CultureInfo.InvariantCulture)}";
            if (cursor is not null && (after is null || scope is null || after.SortKey != scope ||
                !long.TryParse(after.Then, NumberStyles.None, CultureInfo.InvariantCulture, out var externalId) || externalId <= 0))
                return Error.Validation("SRV_WORK_CURSOR_INVALID", "The saved-ticket page does not belong to this customer.");
            if (binding is null) return new PagedResult<TicketWorkRef>([], null, 0);
            await using var db = CreateReadContext();
            await using var lease = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ownerCt);
            var query = Eligible(db, binding);
            var total = await query.CountAsync(ownerCt);
            if (after is not null)
            {
                var lastExternal = long.Parse(after.Then!, CultureInfo.InvariantCulture);
                query = query.Where(row => row.ExternalId > lastExternal || row.ExternalId == lastExternal && row.Id.CompareTo(after.Id) > 0);
            }
            var take = KeysetCursor.ClampLimit(limit);
            var page = await query.OrderBy(row => row.ExternalId).ThenBy(row => row.Id).Take(take + 1).ToListAsync(ownerCt);
            var rows = page.Take(take).Select(ToRef).ToList();
            var next = page.Count > take ? new KeysetCursor(scope!, rows[^1].Id,
                rows[^1].ExternalId.ToString(CultureInfo.InvariantCulture)).Encode() : null;
            await lease.CommitAsync(ownerCt);
            return new PagedResult<TicketWorkRef>(rows, next, total);
        }, ct), cancellationToken);

    private ServiceDbContext CreateReadContext() => new(new DbContextOptionsBuilder<ServiceDbContext>(options)
        .UseSqlServer(sql => sql.ExecutionStrategy(dependencies => new NonRetryingExecutionStrategy(dependencies))).Options);

    private static IQueryable<Ticket> Eligible(ServiceDbContext db, TicketOwnerBinding binding) => db.Tickets.AsNoTracking()
        .Where(row => row.OrganizationId == binding.OrganizationId && EF.Functions.Collate(row.System, "Latin1_General_100_BIN2") == "atera" &&
            row.ExternalId > 0 && row.OwnerCustomerId == binding.CustomerId && row.OwnerLinkId == binding.LinkId && row.ImportedAt != null);

    private static TicketWorkRef ToRef(Ticket ticket) => new(ticket.Id, ticket.OrganizationId, ticket.ExternalId, ticket.Title, ticket.Status, ticket.ImportedAt!.Value);
}
