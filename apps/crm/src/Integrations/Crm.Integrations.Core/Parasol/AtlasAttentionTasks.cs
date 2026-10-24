using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.SharedKernel.Application;

namespace Crm.Integrations.Core.Parasol;

/// <summary>
/// The work My day's preview rows already have, from CRM tasks only: one call for every customer of the snapshot instead of
/// a request per customer from the browser. No Atlas read; the ids are the preview the same read just produced.
/// </summary>
internal sealed class AtlasAttentionTasks(ICurrentUser user, IActivitiesApi activities) : IAtlasAttentionTasks
{
    public async Task<IReadOnlyDictionary<Guid, IReadOnlyList<AtlasObservationTaskLink>>?> ReadAsync(
        IReadOnlyList<(AtlasAttentionBinding Binding, IReadOnlyList<string> ObservationIds)> previews, CancellationToken ct)
    {
        if (!user.HasPermission(Permissions.ActivitiesRead)) return null;
        var asked = previews.Where(p => p.ObservationIds.Count > 0)
            .Select(p => new SourceTaskQuery(p.Binding.WorkspaceId, p.Binding.ClientId, p.Binding.CustomerId, p.ObservationIds)).ToList();
        var found = asked.Count == 0 ? [] : await activities.FindSourceTasksAsync(asked, ct) is { IsSuccess: true } read ? read.Value : null;
        if (found is null) return null;
        var byCustomer = found.ToLookup(f => f.OrganizationId);
        return previews.ToDictionary(p => p.Binding.CustomerId, p => (IReadOnlyList<AtlasObservationTaskLink>)byCustomer[p.Binding.CustomerId]
            .Select(f => new AtlasObservationTaskLink(f.ObservationId, f.Task, f.AssigneeName)).ToList());
    }
}
