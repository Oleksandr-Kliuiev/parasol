using System.Data;
using Crm.Contracts.Persistence;
using Crm.Infrastructure.Persistence;
using Crm.TimeTracking.Features;
using Crm.TimeTracking.Persistence;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public sealed class TimeBankBoundarySqlTests(CrmWebFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    [Fact]
    public async Task Joined_context_disposal_and_repeated_binding_disposal_leave_only_the_time_owner_in_control()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var source = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(); var contracts = scope.ServiceProvider.GetRequiredService<ContractsDbContext>();
        var boundary = scope.ServiceProvider.GetRequiredService<TimeBankTransaction>();
        await using var command = await TimeMutationScope.OpenAsync(source, Ct);
        var first = boundary.Bind(command.Db);
        Should.Throw<InvalidOperationException>(() => boundary.Bind(command.Db));
        await using (var joined = (await boundary.JoinAsync(contracts, o => new ContractsDbContext(o), Ct))!)
        {
            ReferenceEquals(joined.Database.GetDbConnection(), command.Db.Database.GetDbConnection()).ShouldBeTrue();
            ReferenceEquals(joined.Database.CurrentTransaction!.GetDbTransaction(), command.Db.Database.CurrentTransaction!.GetDbTransaction()).ShouldBeTrue();
        }
        command.Db.Database.CurrentTransaction.ShouldNotBeNull();
        (await command.Db.Database.SqlQueryRaw<int>("SELECT @@TRANCOUNT AS [Value]").SingleAsync(Ct)).ShouldBe(1);
        first.Dispose();
        using (boundary.Bind(command.Db))
        {
            first.Dispose(); // An old disposed lease must not unbind this new lease.
            await using var joined = await boundary.JoinAsync(contracts, o => new ContractsDbContext(o), Ct);
            joined.ShouldNotBeNull();
        }
        (await boundary.JoinAsync(contracts, o => new ContractsDbContext(o), Ct)).ShouldBeNull();
        await command.CommitAsync(Ct);
    }

    [Theory]
    [InlineData("database")] [InlineData("identity")] [InlineData("endpoint")]
    public async Task A_different_module_database_or_identity_is_refused_before_opening_its_connection(string mismatch)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await using var owner = await TimeMutationScope.OpenAsync(scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>(), Ct);
        var boundary = scope.ServiceProvider.GetRequiredService<TimeBankTransaction>(); using var binding = boundary.Bind(owner.Db);
        var settings = new SqlConnectionStringBuilder(factory.RuntimeConnectionString);
        if (mismatch == "database") settings.InitialCatalog = "synthetic_wrong_database";
        if (mismatch == "identity") settings.UserID = "synthetic_wrong_identity";
        if (mismatch == "endpoint") settings.DataSource = "127.0.0.1,1";
        await using var source = new ContractsDbContext(new DbContextOptionsBuilder<ContractsDbContext>().UseSqlServer(settings.ConnectionString).Options);
        source.Database.GetDbConnection().State.ShouldBe(ConnectionState.Closed); var created = false;
        var error = await Should.ThrowAsync<InvalidOperationException>(() => boundary.JoinAsync(source, options => { created = true; return new ContractsDbContext(options); }, Ct));
        error.Message.ShouldBe("Time and Contracts must use the same database and SQL identity.");
        created.ShouldBeFalse(); source.Database.GetDbConnection().State.ShouldBe(ConnectionState.Closed);
    }

    [Fact]
    public async Task Financial_commands_refuse_an_unowned_existing_transaction_before_any_partial_command()
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await using var db = TimeMutationScope.Fresh(scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>());
        await using var transaction = await db.Database.BeginTransactionAsync(Ct);
        var service = new TimeApprovalService(db, null!, null!, null!, TimeProvider.System, null!, scope.ServiceProvider.GetRequiredService<TimeBankTransaction>(), scope.ServiceProvider.GetRequiredService<TimeBillingGuard>());
        var error = await Should.ThrowAsync<InvalidOperationException>(() => service.ApproveAsync([], Ct));
        error.Message.ShouldBe("A Time/bank command must own its complete transaction.");
        (await db.Database.SqlQueryRaw<int>("SELECT @@TRANCOUNT AS [Value]").SingleAsync(Ct)).ShouldBe(1);
    }

    [Fact]
    public async Task A_retrying_owner_cannot_place_the_command_inside_an_execution_strategy_callback()
    {
        await using var scope = factory.Services.CreateAsyncScope(); var db = scope.ServiceProvider.GetRequiredService<TimeTrackingDbContext>();
        var boundary = scope.ServiceProvider.GetRequiredService<TimeBankTransaction>();
        await db.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
        {
            await using var transaction = await db.Database.BeginTransactionAsync(Ct);
            Should.Throw<InvalidOperationException>(() => boundary.Bind(db)).Message.ShouldBe("A financial command boundary must not replay its callback.");
        });
    }
}
