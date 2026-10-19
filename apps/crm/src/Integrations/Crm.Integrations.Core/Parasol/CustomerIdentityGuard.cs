using System.Data;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Read-only fence between a source read and the Activities commit. No remote HTTP while SQL locks are held.</summary>
public sealed class CustomerIdentityGuard(IntegrationDbContext db, CustomerIdentityService identities)
{
    internal Task<Result<T>> WithCurrentAsync<T>(CustomerIdentityView expected,
        Func<CancellationToken, Task<Result<T>>> action, CancellationToken ct) =>
        db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
            await db.Database.ExecuteSqlRawAsync(
                "DECLARE @r int; EXEC @r = sys.sp_getapplock @Resource=N'parasol-customer-identity', @LockMode=N'Shared', @LockOwner=N'Transaction', @LockTimeout=10000; IF @r < 0 THROW 51000, 'Customer identity is busy.', 1;", ct);
            var current = await identities.GetAsync(expected.CustomerId, ct);
            if (!current.IsSuccess) return Result<T>.Failure(current.Error!);
            if (current.Value.Atlas != expected.Atlas || current.Value.LinkId != expected.LinkId)
                return Result<T>.Failure(Error.Conflict("PARASOL_TASK_IDENTITY_CHANGED", "The customer mapping changed. Review the source again."));
            // Only Activities writes. Re-execution after an uncertain read-only transaction adopts its permanent receipt.
            return await action(ct);
        });
}
