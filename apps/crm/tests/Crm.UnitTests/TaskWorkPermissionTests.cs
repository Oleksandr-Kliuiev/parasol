using Crm.Activities.Features;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.TimeTracking.Features;

namespace Crm.UnitTests;

public sealed class TaskWorkPermissionTests
{
    [Theory]
    [InlineData(Permissions.ActivitiesRead)] [InlineData(Permissions.ServiceRead)]
    public async Task Ticket_read_requires_both_permissions_before_any_database_lookup(string missing)
    {
        var user = new User([Permissions.ActivitiesRead, Permissions.ActivitiesWrite, Permissions.ServiceRead], missing);
        var api = new ActivityTicketService(null!, null!, null!, user);
        (await api.GetAsync(Guid.NewGuid(), Guid.NewGuid(), default)).Error!.Code.ShouldBe("ACT_WORK_FORBIDDEN");
    }

    [Theory]
    [InlineData(Permissions.ActivitiesRead)] [InlineData(Permissions.ActivitiesWrite)] [InlineData(Permissions.ServiceRead)]
    public async Task Ticket_mutation_requires_each_permission_before_any_database_lookup(string missing)
    {
        var user = new User([Permissions.ActivitiesRead, Permissions.ActivitiesWrite, Permissions.ServiceRead], missing);
        var api = new ActivityTicketService(null!, null!, null!, user);
        (await api.PutAsync(Guid.NewGuid(), new(Guid.NewGuid(), Guid.NewGuid()), "etag", default)).Error!.Code.ShouldBe("ACT_WORK_FORBIDDEN");
    }

    [Theory]
    [InlineData(Permissions.ServiceRead)] [InlineData(Permissions.ActivitiesRead)]
    public async Task Verified_task_time_requires_service_and_activity_read_in_addition_to_own_time(string missing)
    {
        var user = new User([Permissions.TimeOwn, Permissions.ServiceRead, Permissions.ActivitiesRead], missing);
        var api = new TimeEntryService(null!, null!, null!, null!, null!, null!, null!, null!, user, TimeProvider.System, null!);
        var request = new TimeEntryRequest(Guid.NewGuid(), null, new(2099, 4, 23), 1, null, false, false, false, null,
            null, null, null, Guid.NewGuid(), Guid.NewGuid());
        (await api.CreateAsync(request, default)).Error!.Code.ShouldBe("TIM_WORK_FORBIDDEN");
    }

    [Fact]
    public async Task Origin_without_exact_saved_ticket_is_invalid_before_any_database_lookup()
    {
        var user = new User([Permissions.TimeOwn, Permissions.ServiceRead, Permissions.ActivitiesRead]);
        var api = new TimeEntryService(null!, null!, null!, null!, null!, null!, null!, null!, user, TimeProvider.System, null!);
        var request = new TimeEntryRequest(Guid.NewGuid(), null, new(2099, 4, 23), 1, null, false, false, false, null,
            12, "User supplied title", null, null, Guid.NewGuid());
        (await api.CreateAsync(request, default)).Error!.Code.ShouldBe("TIM_TICKET_INVALID");
    }

    private sealed class User(string[] permissions, string? missing = null) : ICurrentUser
    {
        public Guid? UserId { get; } = Guid.NewGuid();
        public string DisplayName => "Synthetic employee";
        public bool IsAuthenticated => true;
        public bool HasPermission(string permission) => permission != missing && permissions.Contains(permission);
    }
}
