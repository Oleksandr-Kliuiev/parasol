using Crm.Projects.Contracts;
using Crm.Projects.Domain;

namespace Crm.UnitTests;

public class ProjectsDomainTests
{
    private static readonly DateOnly Today = new(2026, 9, 22);

    private static ProjectDetails Details(ProjectBillingModel model = ProjectBillingModel.PerPhase) => new(
        Guid.NewGuid(), "M365 migration Havbris", ProjectType.M365Migration, model, Guid.NewGuid(),
        new DateOnly(2026, 10, 1), new DateOnly(2026, 12, 31), 120m, 180_000m, null, null, null);

    private static PhaseDetails Phase(string name = "Pilot", decimal fee = 40_000m, bool bill = true) =>
        new(name, new DateOnly(2026, 10, 1), new DateOnly(2026, 10, 31), 40m, fee, bill, null);

    private static Project Project(ProjectBillingModel model = ProjectBillingModel.PerPhase) =>
        Crm.Projects.Domain.Project.Create("P-2026-0001", Details(model)).Value;

    [Fact]
    public void A_project_starts_planned_and_numbers_its_phases_in_order()
    {
        var project = Project();

        project.Status.ShouldBe(ProjectStatus.Planned);
        project.AddPhase(Phase("Analysis")).Value.Order.ShouldBe(1);
        project.AddPhase(Phase("Pilot")).Value.Order.ShouldBe(2);
        project.AddPhase(Phase("Rollout")).Value.Order.ShouldBe(3);
    }

    [Fact]
    public void A_project_cannot_end_before_it_starts()
    {
        Crm.Projects.Domain.Project.Create("P-2026-0002", Details() with { EndDate = new DateOnly(2026, 9, 1) })
            .Error!.Code.ShouldBe("PRJ_INVALID_PERIOD");
    }

    [Fact]
    public void Completing_a_phase_with_a_fee_queues_it_for_billing()
    {
        var project = Project();
        var phase = project.AddPhase(Phase()).Value;
        project.ClearDomainEvents();

        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today).IsSuccess.ShouldBeTrue();

        var billable = project.DomainEvents.OfType<ProjectPhaseBillable>().ShouldHaveSingleItem();
        billable.Amount.ShouldBe(40_000m);
        billable.CompletedOn.ShouldBe(Today);
        billable.Description.ShouldBe("M365 migration Havbris — Pilot");
        phase.CompletedOn.ShouldBe(Today);

        // Completing it again says nothing new; the billing side is keyed by the phase anyway.
        project.ClearDomainEvents();
        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today);
        project.DomainEvents.ShouldBeEmpty();
    }

    [Fact]
    public void Reopening_a_completed_phase_takes_the_charge_back()
    {
        var project = Project();
        var phase = project.AddPhase(Phase()).Value;
        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today);
        project.ClearDomainEvents();

        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Active, Today).IsSuccess.ShouldBeTrue();

        project.DomainEvents.OfType<ProjectPhaseBillingCancelled>().ShouldHaveSingleItem().PhaseId.ShouldBe(phase.Id);
        phase.CompletedOn.ShouldBeNull();
    }

    [Fact]
    public void A_phase_without_a_fee_is_only_a_stage_of_work()
    {
        var project = Project(ProjectBillingModel.TimeAndMaterial);
        var phase = project.AddPhase(Phase(fee: 0m)).Value;
        phase.BillOnCompletion.ShouldBeFalse();

        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today);

        project.DomainEvents.OfType<ProjectPhaseBillable>().ShouldBeEmpty();
    }

    [Fact]
    public void A_phase_with_open_tasks_cannot_be_completed()
    {
        var project = Project();
        var phase = project.AddPhase(Phase()).Value;
        var task = project.AddTask(phase.Id, new TaskDetails("Migrate mailboxes", null, null, 8m, null)).Value;

        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today).Error!.Code.ShouldBe("PRJ_OPEN_TASKS");

        project.UpdateTask(task.Id, new TaskDetails("Migrate mailboxes", null, null, 8m, null), ProjectTaskStatus.Done);
        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today).IsSuccess.ShouldBeTrue();
    }

    [Fact]
    public void A_project_with_open_phases_cannot_be_completed_and_a_completed_phase_is_kept()
    {
        var project = Project();
        var phase = project.AddPhase(Phase()).Value;

        project.SetStatus(ProjectStatus.Completed, Today).Error!.Code.ShouldBe("PRJ_OPEN_PHASES");

        project.SetPhaseStatus(phase.Id, ProjectPhaseStatus.Completed, Today);
        project.RemovePhase(phase.Id).Error!.Code.ShouldBe("PRJ_PHASE_COMPLETED");

        project.SetStatus(ProjectStatus.Completed, Today).IsSuccess.ShouldBeTrue();
        project.CompletedOn.ShouldBe(Today);
        project.IsOpen.ShouldBeFalse();

        // A closed project is read-only until someone reopens it.
        project.AddPhase(Phase("Late")).Error!.Code.ShouldBe("PRJ_CLOSED");
    }
}
