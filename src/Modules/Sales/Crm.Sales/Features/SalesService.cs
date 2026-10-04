using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Identity.Contracts;
using Crm.Infrastructure.Persistence;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;
using Crm.Sales.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Results;
using Microsoft.EntityFrameworkCore;

namespace Crm.Sales.Features;

internal sealed class SalesService(
    SalesDbContext db,
    ICustomersApi customers,
    IUserDirectory users,
    ICurrentUser currentUser,
    TimeProvider time)
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    private DateOnly Today => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);

    // ---------- Pipeline stages ----------

    public async Task<IReadOnlyList<StageDto>> ListStagesAsync(bool includeInactive, CancellationToken ct)
    {
        // Tracked: each row carries its ETag.
        var stages = await db.PipelineStages.Where(s => includeInactive || s.IsActive).OrderBy(s => s.Order).ToListAsync(ct);
        var counts = await db.Opportunities.AsNoTracking()
            .Where(o => o.Status == OpportunityStatus.Open)
            .GroupBy(o => o.StageId)
            .Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(x => x.Key, x => x.Count, ct);
        return stages.Select(s => new StageDto(s.Id, s.Name, s.Probability, s.Order, s.IsWon, s.IsLost, s.IsActive, counts.GetValueOrDefault(s.Id), db.GetETag(s))).ToList();
    }

    public async Task<Result<StageDto>> SaveStageAsync(Guid? id, StageRequest request, string? ifMatch, CancellationToken ct)
    {
        PipelineStage stage;
        if (id is null)
        {
            var created = PipelineStage.Create(request.Name, request.Probability, request.Order);
            if (!created.IsSuccess)
            {
                return created.Error!;
            }

            stage = created.Value;
            db.PipelineStages.Add(stage);
        }
        else
        {
            if (await db.PipelineStages.SingleOrDefaultAsync(s => s.Id == id, ct) is not { } existing)
            {
                return SalesErrors.StageNotFound(id.Value);
            }

            if (ifMatch is null || !db.ApplyIfMatch(existing, ifMatch))
            {
                return SalesErrors.InvalidETag;
            }

            var updated = existing.Update(request.Name, request.Probability, request.Order, request.IsActive);
            if (!updated.IsSuccess)
            {
                return updated.Error!;
            }

            stage = existing;
        }

        await db.SaveChangesAsync(ct);
        return (await ListStagesAsync(true, ct)).First(s => s.Id == stage.Id);
    }

    // ---------- Leads ----------

    public async Task<IReadOnlyList<LeadDto>> ListLeadsAsync(LeadStatus? status, bool mineOnly, string? search, CancellationToken ct)
    {
        var leads = db.Leads.AsQueryable();
        if (status is { } value)
        {
            leads = leads.Where(l => l.Status == value);
        }

        if (mineOnly)
        {
            var userId = currentUser.UserId;
            leads = leads.Where(l => l.OwnerId == userId);
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            var term = search.Trim();
            leads = leads.Where(l => l.CompanyName.Contains(term) || (l.Email != null && l.Email.Contains(term)) || (l.ContactName != null && l.ContactName.Contains(term)));
        }

        var rows = await leads.OrderByDescending(l => l.CreatedAt).Take(300).ToListAsync(ct);
        var owners = await users.GetUsersAsync(rows.Where(l => l.OwnerId != null).Select(l => l.OwnerId!.Value).Distinct().ToList(), ct);
        return rows.Select(l => ToDto(l, owners)).ToList();
    }

    public async Task<Result<LeadDto>> CreateLeadAsync(LeadRequest request, CancellationToken ct)
    {
        var created = Lead.Create(ToDetails(request));
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.Leads.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return ToDto(created.Value, await OwnersOfAsync([created.Value], ct));
    }

    public async Task<Result<LeadDto>> UpdateLeadAsync(Guid id, LeadRequest request, string ifMatch, CancellationToken ct) =>
        await MutateLeadAsync(id, ifMatch, lead => lead.Update(ToDetails(request)), ct);

    public async Task<Result<LeadDto>> QualifyLeadAsync(Guid id, CancellationToken ct) =>
        await MutateLeadAsync(id, null, lead => lead.Qualify(), ct);

    public async Task<Result<LeadDto>> DisqualifyLeadAsync(Guid id, string reason, CancellationToken ct) =>
        await MutateLeadAsync(id, null, lead => lead.Disqualify(reason, time.GetUtcNow()), ct);

    /// <summary>FR-SAL-01: the lead becomes an organization with its first contact, and optionally a deal.</summary>
    public async Task<Result<LeadDto>> ConvertLeadAsync(Guid id, ConvertLeadRequest request, CancellationToken ct)
    {
        if (await db.Leads.SingleOrDefaultAsync(l => l.Id == id, ct) is not { } lead)
        {
            return SalesErrors.LeadNotFound(id);
        }

        if (lead.Status == LeadStatus.Converted)
        {
            return Error.Conflict("SAL_LEAD_CONVERTED", "The lead is already converted.");
        }

        var imported = await customers.ImportOrganizationAsync(
            new ExternalOrganizationData(lead.CompanyName, lead.OrgNumber, lead.Email, lead.Phone, null, [], null, null, null),
            OrganizationStatus.Prospect,
            ct);

        if (!string.IsNullOrWhiteSpace(lead.ContactName) || !string.IsNullOrWhiteSpace(lead.Email))
        {
            var parts = (lead.ContactName ?? string.Empty).Split(' ', 2, StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            await customers.ImportContactAsync(
                imported.OrganizationId,
                new ExternalContactData(parts.ElementAtOrDefault(0) ?? "-", parts.ElementAtOrDefault(1) ?? "-", lead.Email, lead.Phone, null, null),
                ct);
        }

        Guid? opportunityId = null;
        if (request.CreateOpportunity)
        {
            var stage = await ResolveStageAsync(request.StageId, ct);
            if (stage is null)
            {
                return SalesErrors.StageNotFound(request.StageId ?? Guid.Empty);
            }

            var opportunity = Opportunity.Create(
                new OpportunityDetails(
                    imported.OrganizationId, null, string.IsNullOrWhiteSpace(request.OpportunityName) ? lead.CompanyName : request.OpportunityName!,
                    BusinessLine.Mixed, stage.Id, null, request.ExpectedCloseDate ?? Today.AddMonths(1),
                    request.OneOffAmount ?? 0, request.Mrr ?? 0, request.TermMonths ?? 12, lead.OwnerId ?? currentUser.UserId, lead.Source, null),
                stage.Probability,
                time.GetUtcNow());
            if (!opportunity.IsSuccess)
            {
                return opportunity.Error!;
            }

            db.Opportunities.Add(opportunity.Value);
            opportunityId = opportunity.Value.Id;
        }

        var converted = lead.Convert(imported.OrganizationId, opportunityId, time.GetUtcNow());
        if (!converted.IsSuccess)
        {
            return converted.Error!;
        }

        await db.SaveChangesAsync(ct);
        return ToDto(lead, await OwnersOfAsync([lead], ct));
    }

    // ---------- Opportunities ----------

    public async Task<IReadOnlyList<OpportunityDto>> ListOpportunitiesAsync(OpportunityQuery query, CancellationToken ct)
    {
        var rows = await FilterOpportunities(query).OrderBy(o => o.ExpectedCloseDate).ThenBy(o => o.Id).Take(500).ToListAsync(ct);
        return await ToDtosAsync(rows, ct);
    }

    public async Task<Result<OpportunityDto>> GetOpportunityAsync(Guid id, CancellationToken ct)
    {
        var opportunity = await db.Opportunities.SingleOrDefaultAsync(o => o.Id == id, ct);
        return opportunity is null ? SalesErrors.OpportunityNotFound(id) : (await ToDtosAsync([opportunity], ct))[0];
    }

    public async Task<PipelineView> GetPipelineAsync(OpportunityQuery query, CancellationToken ct)
    {
        var stages = await db.PipelineStages.AsNoTracking().Where(s => s.IsActive).OrderBy(s => s.Order).ToListAsync(ct);
        var open = await FilterOpportunities(query with { Status = OpportunityStatus.Open })
            .OrderBy(o => o.ExpectedCloseDate).Take(500).ToListAsync(ct);
        var dtos = await ToDtosAsync(open, ct);
        var columns = stages.Select(stage => new PipelineColumn(
            stage.Id,
            stage.Name,
            stage.Probability,
            dtos.Count(o => o.StageId == stage.Id),
            dtos.Where(o => o.StageId == stage.Id).Sum(o => o.ForecastAmount),
            dtos.Where(o => o.StageId == stage.Id).ToList())).ToList();

        var forecast = dtos
            .GroupBy(o => new { o.ExpectedCloseDate.Year, o.ExpectedCloseDate.Month })
            .OrderBy(g => g.Key.Year).ThenBy(g => g.Key.Month)
            .Select(g => new ForecastMonth(g.Key.Year, g.Key.Month, g.Count(), g.Sum(o => o.ForecastAmount), g.Sum(o => o.OneOffAmount + (o.Mrr * Math.Min(o.TermMonths, 12)))))
            .Take(12)
            .ToList();
        return new PipelineView(columns, forecast, dtos.Count(o => o.IsStale));
    }

    public async Task<Result<OpportunityDto>> CreateOpportunityAsync(OpportunityRequest request, CancellationToken ct)
    {
        if (await customers.GetOrganizationAsync(request.OrganizationId, ct) is null)
        {
            return Error.Validation("SAL_UNKNOWN_ORGANIZATION", "The organization does not exist.");
        }

        if (await ResolveStageAsync(request.StageId, ct) is not { } stage)
        {
            return SalesErrors.StageNotFound(request.StageId);
        }

        var created = Opportunity.Create(ToDetails(request), stage.Probability, time.GetUtcNow());
        if (!created.IsSuccess)
        {
            return created.Error!;
        }

        db.Opportunities.Add(created.Value);
        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([created.Value], ct))[0];
    }

    public async Task<Result<OpportunityDto>> UpdateOpportunityAsync(Guid id, OpportunityRequest request, string ifMatch, CancellationToken ct)
    {
        if (await db.Opportunities.SingleOrDefaultAsync(o => o.Id == id, ct) is not { } opportunity)
        {
            return SalesErrors.OpportunityNotFound(id);
        }

        if (!db.ApplyIfMatch(opportunity, ifMatch))
        {
            return SalesErrors.InvalidETag;
        }

        if (await ResolveStageAsync(request.StageId, ct) is not { } stage)
        {
            return SalesErrors.StageNotFound(request.StageId);
        }

        var updated = opportunity.Update(ToDetails(request), stage.Probability);
        if (!updated.IsSuccess)
        {
            return updated.Error!;
        }

        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([opportunity], ct))[0];
    }

    public async Task<Result<OpportunityDto>> MoveOpportunityAsync(Guid id, MoveStageRequest request, CancellationToken ct)
    {
        if (await db.Opportunities.SingleOrDefaultAsync(o => o.Id == id, ct) is not { } opportunity)
        {
            return SalesErrors.OpportunityNotFound(id);
        }

        if (await ResolveStageAsync(request.StageId, ct) is not { } stage)
        {
            return SalesErrors.StageNotFound(request.StageId);
        }

        var moved = opportunity.MoveTo(stage.Id, stage.Probability, stage.IsWon, stage.IsLost, request.LostReason, Today, time.GetUtcNow());
        if (!moved.IsSuccess)
        {
            return moved.Error!;
        }

        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([opportunity], ct))[0];
    }

    public async Task<Result<OpportunityDto>> ReopenOpportunityAsync(Guid id, CancellationToken ct)
    {
        if (await db.Opportunities.SingleOrDefaultAsync(o => o.Id == id, ct) is not { } opportunity)
        {
            return SalesErrors.OpportunityNotFound(id);
        }

        var stage = await db.PipelineStages.AsNoTracking()
            .Where(s => s.IsActive && !s.IsWon && !s.IsLost)
            .OrderBy(s => s.Order)
            .FirstOrDefaultAsync(ct);
        if (stage is null)
        {
            return SalesErrors.StageNotFound(Guid.Empty);
        }

        var reopened = opportunity.Reopen(stage.Id, stage.Probability, time.GetUtcNow());
        if (!reopened.IsSuccess)
        {
            return reopened.Error!;
        }

        await db.SaveChangesAsync(ct);
        return (await ToDtosAsync([opportunity], ct))[0];
    }

    // ---------- Shared ----------

    private IQueryable<Opportunity> FilterOpportunities(OpportunityQuery query)
    {
        // Tracked: the list feeds the board, whose cards are edited straight away, so every row needs its ETag.
        var opportunities = db.Opportunities.AsQueryable();
        if (!string.IsNullOrWhiteSpace(query.Search))
        {
            var term = query.Search.Trim();
            opportunities = opportunities.Where(o => o.Name.Contains(term));
        }

        if (query.OrganizationId is { } organizationId)
        {
            opportunities = opportunities.Where(o => o.OrganizationId == organizationId);
        }

        if (query.MineOnly)
        {
            var userId = currentUser.UserId;
            opportunities = opportunities.Where(o => o.OwnerId == userId);
        }
        else if (query.OwnerId is { } ownerId)
        {
            opportunities = opportunities.Where(o => o.OwnerId == ownerId);
        }

        if (query.StageId is { } stageId)
        {
            opportunities = opportunities.Where(o => o.StageId == stageId);
        }

        if (query.Status is { } status)
        {
            opportunities = opportunities.Where(o => o.Status == status);
        }

        if (query.StaleOnly)
        {
            var since = time.GetUtcNow().AddDays(-Opportunity.StaleAfterDays);
            opportunities = opportunities.Where(o => o.Status == OpportunityStatus.Open && o.LastActivityAt < since);
        }

        return opportunities;
    }

    private async Task<PipelineStage?> ResolveStageAsync(Guid? stageId, CancellationToken ct) =>
        stageId is { } id
            ? await db.PipelineStages.AsNoTracking().SingleOrDefaultAsync(s => s.Id == id, ct)
            : await db.PipelineStages.AsNoTracking().Where(s => s.IsActive && !s.IsWon && !s.IsLost).OrderBy(s => s.Order).FirstOrDefaultAsync(ct);

    private async Task<Result<LeadDto>> MutateLeadAsync(Guid id, string? ifMatch, Func<Lead, Result> change, CancellationToken ct)
    {
        if (await db.Leads.SingleOrDefaultAsync(l => l.Id == id, ct) is not { } lead)
        {
            return SalesErrors.LeadNotFound(id);
        }

        if (ifMatch is not null && !db.ApplyIfMatch(lead, ifMatch))
        {
            return SalesErrors.InvalidETag;
        }

        var result = change(lead);
        if (!result.IsSuccess)
        {
            return result.Error!;
        }

        await db.SaveChangesAsync(ct);
        return ToDto(lead, await OwnersOfAsync([lead], ct));
    }

    private async Task<IReadOnlyDictionary<Guid, UserSummary>> OwnersOfAsync(IReadOnlyList<Lead> leads, CancellationToken ct) =>
        await users.GetUsersAsync(leads.Where(l => l.OwnerId != null).Select(l => l.OwnerId!.Value).Distinct().ToList(), ct);

    private LeadDto ToDto(Lead lead, IReadOnlyDictionary<Guid, UserSummary> owners) => new(
        lead.Id, lead.CompanyName, lead.OrgNumber, lead.ContactName, lead.Email, lead.Phone, lead.Source, lead.Status,
        lead.OwnerId is { } id && owners.TryGetValue(id, out var owner) ? new RefDto(owner.Id, owner.DisplayName) : null,
        lead.Notes, lead.DisqualifyReason, lead.OrganizationId, lead.OpportunityId, lead.CreatedAt, db.GetETag(lead));

    private async Task<IReadOnlyList<OpportunityDto>> ToDtosAsync(IReadOnlyList<Opportunity> opportunities, CancellationToken ct)
    {
        var organizations = await customers.GetOrganizationNamesAsync(opportunities.Select(o => o.OrganizationId).Distinct().ToList(), ct);
        var contacts = await customers.GetContactNamesAsync(opportunities.Where(o => o.ContactId != null).Select(o => o.ContactId!.Value).Distinct().ToList(), ct);
        var owners = await users.GetUsersAsync(opportunities.Where(o => o.OwnerId != null).Select(o => o.OwnerId!.Value).Distinct().ToList(), ct);
        var stageIds = opportunities.Select(o => o.StageId).Distinct().ToList();
        var stages = await db.PipelineStages.AsNoTracking().Where(s => stageIds.Contains(s.Id)).ToDictionaryAsync(s => s.Id, s => s.Name, ct);
        var now = time.GetUtcNow();

        return opportunities.Select(o => new OpportunityDto(
            o.Id,
            new RefDto(o.OrganizationId, organizations.GetValueOrDefault(o.OrganizationId, "—")),
            o.ContactId,
            o.ContactId is { } contactId ? contacts.GetValueOrDefault(contactId) : null,
            o.Name,
            o.BusinessLine,
            o.StageId,
            stages.GetValueOrDefault(o.StageId, "—"),
            o.Probability,
            o.ExpectedCloseDate,
            o.OneOffAmount,
            o.Mrr,
            o.TermMonths,
            o.ForecastAmount,
            o.OwnerId is { } ownerId && owners.TryGetValue(ownerId, out var owner) ? new RefDto(owner.Id, owner.DisplayName) : null,
            o.Source,
            o.Competitor,
            o.Status,
            o.LostReason,
            o.ClosedOn,
            o.LastActivityAt,
            o.IsStale(now),
            db.GetETag(o))).ToList();
    }

    private static LeadDetails ToDetails(LeadRequest r) => new(r.CompanyName, r.OrgNumber, r.ContactName, r.Email, r.Phone, r.Source, r.OwnerId, r.Notes);

    private static OpportunityDetails ToDetails(OpportunityRequest r) => new(
        r.OrganizationId, r.ContactId, r.Name, r.BusinessLine, r.StageId, r.Probability, r.ExpectedCloseDate, r.OneOffAmount, r.Mrr, r.TermMonths,
        r.OwnerId, r.Source, r.Competitor);
}

/// <summary>Deals follow their organization into a merge.</summary>
internal sealed class SalesMergeHandler(SalesDbContext db, ICustomersApi customers) : IDomainEventHandler<OrganizationsMerged>
{
    public async Task HandleAsync(OrganizationsMerged domainEvent, CancellationToken cancellationToken)
    {
        // Delivered late (retried or replayed) after the merge was undone: the organizations are apart again (DEV-07).
        if (await customers.IsMergeUndoneAsync(domainEvent.MergeId, cancellationToken))
        {
            return;
        }

        await db.Opportunities.Where(o => o.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(o => o.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
        await db.Leads.Where(l => l.OrganizationId == domainEvent.SourceOrganizationId)
            .ExecuteUpdateAsync(u => u.SetProperty(l => l.OrganizationId, domainEvent.TargetOrganizationId), cancellationToken);
    }
}

internal sealed class SalesApi(SalesDbContext db) : ISalesApi
{
    public async Task<IReadOnlyDictionary<Guid, OpportunityRef>> GetOpportunitiesAsync(IReadOnlyCollection<Guid> opportunityIds, CancellationToken cancellationToken) =>
        await db.Opportunities.AsNoTracking()
            .Where(o => opportunityIds.Contains(o.Id))
            .ToDictionaryAsync(o => o.Id, o => new OpportunityRef(o.Id, o.Name, o.OrganizationId, o.Status), cancellationToken);

    public async Task<IReadOnlyList<OpportunityRef>> GetOpenOpportunitiesAsync(Guid organizationId, CancellationToken cancellationToken) =>
        await db.Opportunities.AsNoTracking()
            .Where(o => o.OrganizationId == organizationId && o.Status == OpportunityStatus.Open)
            .OrderBy(o => o.ExpectedCloseDate)
            .Select(o => new OpportunityRef(o.Id, o.Name, o.OrganizationId, o.Status))
            .ToListAsync(cancellationToken);

    public async Task<PipelineSummary> GetPipelineSummaryAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var stale = now.AddDays(-Opportunity.StaleAfterDays);
        var quarter = now.AddDays(-90);
        var open = await db.Opportunities.AsNoTracking()
            .Where(o => o.Status == OpportunityStatus.Open)
            .Select(o => new { o.ForecastAmount, o.OneOffAmount, o.Mrr, o.TermMonths, o.LastActivityAt })
            .ToListAsync(cancellationToken);
        var closed = await db.Opportunities.AsNoTracking()
            .Where(o => o.Status != OpportunityStatus.Open && o.ClosedOn != null && o.ModifiedAt >= quarter)
            .Select(o => new { o.Status, o.OneOffAmount, o.Mrr, o.TermMonths })
            .ToListAsync(cancellationToken);

        return new PipelineSummary(
            open.Count,
            decimal.Round(open.Sum(o => o.ForecastAmount), 2),
            decimal.Round(open.Sum(o => o.OneOffAmount + (o.Mrr * Math.Min(Math.Max(o.TermMonths, 0), 12))), 2),
            open.Count(o => o.LastActivityAt < stale),
            closed.Count(o => o.Status == OpportunityStatus.Won),
            decimal.Round(closed.Where(o => o.Status == OpportunityStatus.Won).Sum(o => o.OneOffAmount + (o.Mrr * Math.Min(Math.Max(o.TermMonths, 0), 12))), 2),
            closed.Count(o => o.Status == OpportunityStatus.Lost));
    }

    public async Task<IReadOnlyList<StaleOpportunity>> GetStaleOpportunitiesAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var cutoff = now.AddDays(-Opportunity.StaleAfterDays);
        var rows = await db.Opportunities.AsNoTracking()
            .Where(o => o.Status == OpportunityStatus.Open && o.LastActivityAt < cutoff)
            .OrderBy(o => o.LastActivityAt)
            .Take(200)
            .Select(o => new { o.Id, o.Name, o.OrganizationId, o.OwnerId, o.LastActivityAt })
            .ToListAsync(cancellationToken);

        return rows
            .Select(o => new StaleOpportunity(o.Id, o.Name, o.OrganizationId, o.OwnerId, o.LastActivityAt, (int)(now - o.LastActivityAt).TotalDays))
            .ToList();
    }
}
