using Crm.TimeTracking.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

[Collection(DatabaseAdministrationCollection.Name)]
public sealed class TimeMonthLockTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Theory]
    [InlineData(DatabaseRoles.Web)] [InlineData(DatabaseRoles.Worker)]
    public async Task Both_runtime_roles_can_use_shared_and_exclusive_transaction_admission(string role)
    {
        var user = "month_role_" + Guid.NewGuid().ToString("N"); var date = Date();
        await factory.AdminSqlAsync($"CREATE USER [{user}] WITHOUT LOGIN; ALTER ROLE [{role}] ADD MEMBER [{user}];");
        try
        {
            await using var connection = new SqlConnection(factory.AdminConnectionString); await connection.OpenAsync(Ct);
            await using var command = connection.CreateCommand();
            command.CommandText = $"EXECUTE AS USER=N'{user}';"; await command.ExecuteNonQueryAsync(Ct);
            try
            {
                foreach (var mode in new[] { "Shared", "Exclusive" })
                {
                    command.CommandText = "BEGIN TRAN; DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource, @LockMode=@mode,@LockOwner='Transaction',@DbPrincipal='public',@LockTimeout=0; ROLLBACK; SELECT @r;";
                    command.Parameters.Clear(); command.Parameters.AddWithValue("resource", TimeMonth.Of(date).Resource); command.Parameters.AddWithValue("mode", mode);
                    ((int)(await command.ExecuteScalarAsync(Ct))!).ShouldBeGreaterThanOrEqualTo(0);
                }
            }
            finally { command.CommandText = "REVERT;"; await command.ExecuteNonQueryAsync(Ct); }
        }
        finally { await factory.AdminSqlAsync($"ALTER ROLE [{role}] DROP MEMBER [{user}]; DROP USER [{user}];"); }
    }

    [Fact]
    public async Task Shared_writers_coexist_and_failed_exclusive_admission_cannot_mutate_or_leave_a_lock_after_rollback()
    {
        var date = Date(); await using var scope = factory.Services.CreateAsyncScope();
        var source = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        await using (var first = await TimeMutationScope.OpenAsync(source, Ct))
        {
            (await MonthAdmission.AcquireAsync(first.Db, [TimeMonth.Of(date)], MonthMode.Shared, Ct)).IsSuccess.ShouldBeTrue();
            (await Probe(factory, date, "Shared")).ShouldBeGreaterThanOrEqualTo(0);
            await using var second = await TimeMutationScope.OpenAsync(source, Ct);
            var refused = await MonthAdmission.AcquireAsync(second.Db, [TimeMonth.Of(date)], MonthMode.Exclusive, Ct, timeoutMilliseconds: 0);
            refused.Error!.Code.ShouldBe("TIM_PERIOD_BUSY");
            (await Probe(factory, date, "Exclusive")).ShouldBe(-1);
        }
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }

    [Fact]
    public async Task Cancellation_of_a_waiting_admission_releases_its_owned_transaction_and_does_not_create_a_period()
    {
        var date = Date(); await using var scope = factory.Services.CreateAsyncScope(); var source = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        await using var first = await TimeMutationScope.OpenAsync(source, Ct);
        (await MonthAdmission.AcquireAsync(first.Db, [TimeMonth.Of(date)], MonthMode.Exclusive, Ct)).IsSuccess.ShouldBeTrue();
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        await using (var second = await TimeMutationScope.OpenAsync(source, Ct))
        {
            // SQL's synchronous zero-timeout negative control confirms the first admission is actually held.
            (await Probe(factory, date, "Shared")).ShouldBe(-1);
            var waiting = MonthAdmission.AcquireAsync(second.Db, [TimeMonth.Of(date)], MonthMode.Shared, cancel.Token);
            await WaitForSqlWait(factory, ((SqlConnection)second.Db.Database.GetDbConnection()).ServerProcessId);
            cancel.Cancel();
            await Should.ThrowAsync<OperationCanceledException>(() => waiting);
        }
        await first.CommitAsync(Ct); (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
        (await source.TimePeriods.AnyAsync(p => p.Year == date.Year && p.Month == date.Month, Ct)).ShouldBeFalse();
    }

    [Fact]
    public async Task Admission_requires_a_transaction_and_releases_all_sorted_months_after_an_exception()
    {
        var date = Date(); await using var scope = factory.Services.CreateAsyncScope(); var source = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        await Should.ThrowAsync<InvalidOperationException>(() => MonthAdmission.AcquireAsync(source, [TimeMonth.Of(date)], MonthMode.Shared, Ct));
        await Should.ThrowAsync<ArgumentException>(async () =>
        {
            await using var mutation = await TimeMutationScope.OpenAsync(source, Ct);
            (await MonthAdmission.AcquireAsync(mutation.Db, [TimeMonth.Of(date.AddMonths(1)), TimeMonth.Of(date)], MonthMode.Exclusive, Ct)).IsSuccess.ShouldBeTrue();
            (await Probe(factory, date, "Exclusive")).ShouldBe(-1); (await Probe(factory, date.AddMonths(1), "Exclusive")).ShouldBe(-1);
            throw new ArgumentException("Synthetic failure before saving.");
        });
        (await Probe(factory, date, "Exclusive")).ShouldBeGreaterThanOrEqualTo(0); (await Probe(factory, date.AddMonths(1), "Exclusive")).ShouldBeGreaterThanOrEqualTo(0);
    }
}
