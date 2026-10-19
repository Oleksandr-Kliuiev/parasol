using Crm.Activities.Contracts;
using Crm.Activities.Domain;
using Crm.TimeTracking.Domain;

namespace Crm.UnitTests;

public sealed class TaskWorkDomainTests
{
    [Fact]
    public void Manual_hours_that_round_to_zero_are_refused_before_create_or_any_existing_entry_mutation()
    {
        var details = new ManualTimeEntry(Guid.NewGuid(), Guid.NewGuid(), new(2099, 4, 23), 1.25m, "Work", false, false,
            false, "Existing employee notes", Guid.NewGuid(), 12, "Saved title", null, Guid.NewGuid());
        TimeEntry.CreateManual(details with { Hours = 0.001m }).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
        var entry = TimeEntry.CreateManual(details).Value;
        entry.Update(details with { OrganizationId = Guid.NewGuid(), Hours = 0.001m, Description = "Must not be applied", TicketId = null,
            ExternalTicketId = 77, TicketTitle = "Must not replace", SourceActivityId = null }).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
        entry.Hours.ShouldBe(details.Hours); entry.OrganizationId.ShouldBe(details.OrganizationId); entry.Description.ShouldBe(details.Description);
        entry.TicketId.ShouldBe(details.TicketId); entry.SourceActivityId.ShouldBe(details.SourceActivityId);
        entry.ExternalTicketId.ShouldBe(details.ExternalTicketId); entry.TicketTitle.ShouldBe(details.TicketTitle);
        TimeEntry.CreateManual(details with { Hours = 0.005m }).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
        TimeEntry.CreateManual(details with { Hours = 0.006m }).Value.Hours.ShouldBe(0.01m);
        entry.Update(details with { Hours = 0.005m }).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
        entry.Update(details with { Hours = 0.006m }).IsSuccess.ShouldBeTrue(); entry.Hours.ShouldBe(0.01m);
        TimeEntry.CreateManual(details with { Hours = 24.001m }).Error!.Code.ShouldBe("TIM_INVALID_HOURS");
    }

    [Fact]
    public void Ticket_link_changes_only_the_link_and_preserves_employee_authored_task_details_and_status()
    {
        var now = DateTimeOffset.Parse("2090-01-01T12:34:56Z");
        var details = new ActivityDetails(ActivityType.Task, Guid.NewGuid(), null, null, null, "Employee task", "Manual notes",
            now.AddDays(1), ActivityPriority.High, Guid.NewGuid());
        var task = Activity.Create(details, now).Value;
        task.Complete(Guid.NewGuid(), now).IsSuccess.ShouldBeTrue();
        var completedAt = task.CompletedAt; var completedBy = task.CompletedBy;
        var eventsBeforeLink = task.DomainEvents.Count;
        var ticket = Guid.NewGuid(); task.LinkTicket(ticket).IsSuccess.ShouldBeTrue();
        task.DomainEvents.Count.ShouldBe(eventsBeforeLink);
        task.LinkedTicketId.ShouldBe(ticket); task.Subject.ShouldBe(details.Subject); task.Body.ShouldBe(details.Body);
        task.DueAt.ShouldBe(details.DueAt); task.AssigneeId.ShouldBe(details.AssigneeId); task.Priority.ShouldBe(details.Priority);
        task.Status.ShouldBe(ActivityStatus.Done); task.CompletedAt.ShouldBe(completedAt); task.CompletedBy.ShouldBe(completedBy);
        var count = task.DomainEvents.Count;
        task.LinkTicket(ticket).IsSuccess.ShouldBeTrue(); task.DomainEvents.Count.ShouldBe(count);
        task.LinkTicket(null).IsSuccess.ShouldBeTrue(); task.LinkedTicketId.ShouldBeNull();
        task.DomainEvents.Count.ShouldBe(eventsBeforeLink);
    }

    [Fact]
    public void Erasure_clears_ticket_association_even_when_reapplied_and_deleted_tasks_cannot_be_linked()
    {
        var now = DateTimeOffset.UtcNow;
        var task = Activity.Create(new(ActivityType.Task, Guid.NewGuid(), null, null, null, "Task", null, null,
            ActivityPriority.Normal, null), now).Value;
        task.LinkTicket(Guid.NewGuid()).IsSuccess.ShouldBeTrue();
        task.Erase("synthetic-case").ShouldBeTrue(); task.LinkedTicketId.ShouldBeNull(); task.Erase("synthetic-case").ShouldBeFalse();
        task.LinkTicket(Guid.NewGuid()).Error!.Code.ShouldBe("ACT_TASK_UNAVAILABLE");
    }

    [Theory]
    [InlineData(ActivityType.Note)] [InlineData(ActivityType.Call)] [InlineData(ActivityType.Meeting)]
    public void Only_tasks_have_a_work_ticket_association(ActivityType type)
    {
        var now = DateTimeOffset.UtcNow;
        var activity = Activity.Create(new(type, Guid.NewGuid(), null, null, null, "Activity", null, null, ActivityPriority.Normal, null), now).Value;
        activity.LinkTicket(Guid.NewGuid()).Error!.Code.ShouldBe("ACT_TASK_UNAVAILABLE"); activity.LinkedTicketId.ShouldBeNull();
    }

    [Fact]
    public void Manual_time_update_replaces_the_full_verified_ticket_origin_tuple_and_keeps_explicit_work_values()
    {
        var employee = Guid.NewGuid(); var ticket = Guid.NewGuid(); var task = Guid.NewGuid();
        var request = new ManualTimeEntry(Guid.NewGuid(), employee, new DateOnly(2090, 1, 1), 1.25m, "Work", false, false,
            false, "Actual manual notes", ticket, 12, "Saved title", null, task);
        var entry = TimeEntry.CreateManual(request).Value;
        entry.SourceActivityId.ShouldBe(task); entry.TicketId.ShouldBe(ticket); entry.TechnicianId.ShouldBe(employee);
        var manual = request with { OrganizationId = Guid.NewGuid(), TicketId = null, SourceActivityId = null, ExternalTicketId = 99, TicketTitle = "Manual" };
        entry.Update(manual).IsSuccess.ShouldBeTrue(); entry.TicketId.ShouldBeNull(); entry.SourceActivityId.ShouldBeNull();
        entry.ExternalTicketId.ShouldBe(99); entry.TicketTitle.ShouldBe("Manual"); entry.Hours.ShouldBe(1.25m); entry.Description.ShouldBe(request.Description);
    }
}
