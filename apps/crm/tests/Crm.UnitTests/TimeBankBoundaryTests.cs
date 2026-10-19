using Crm.Infrastructure.Persistence;
using Crm.TimeTracking.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.UnitTests;

public sealed class TimeBankBoundaryTests
{
    [Fact]
    public void A_command_cannot_open_a_financial_boundary_without_the_time_owner_transaction()
    {
        using var db = new TimeTrackingDbContext(new DbContextOptionsBuilder<TimeTrackingDbContext>()
            .UseSqlServer("Server=127.0.0.1,1;Database=unused;Integrated Security=true;TrustServerCertificate=true").Options);
        var boundary = new TimeBankTransaction(new());
        Should.Throw<InvalidOperationException>(() => boundary.Bind(db)).Message.ShouldBe("Time/bank work requires the Time owner's SQL transaction.");
    }
    [Fact]
    public void Inbox_delivery_cannot_opt_into_a_cross_module_command_boundary()
    {
        var handling = new MessageHandlingContext(); handling.Begin(Guid.NewGuid(), "Synthetic handler");
        using var db = new TimeTrackingDbContext(new DbContextOptionsBuilder<TimeTrackingDbContext>()
            .UseSqlServer("Server=127.0.0.1,1;Database=unused;Integrated Security=true;TrustServerCertificate=true").Options);
        Should.Throw<InvalidOperationException>(() => new TimeBankTransaction(handling).Bind(db)).Message.ShouldBe("Time/bank commands cannot run inside an inbox handler.");
    }
}
