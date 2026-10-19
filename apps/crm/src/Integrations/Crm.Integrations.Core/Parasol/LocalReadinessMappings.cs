using System.Data.Common;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Local registry review, with refresh fencing. No claim about source existence, access or complete source coverage.</summary>
internal sealed class LocalReadinessMappings(ILocalMappingSource source, TimeProvider time) : ILocalReadinessMappings
{
    internal const int Limit = 500;
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(3);
    internal static AtlasMappingDiagnostic Unavailable(string status = "UNAVAILABLE") => new(status, "UNKNOWN", "STORED_LOCAL_REGISTRY", Limit, null, null);

    public async Task<AtlasMappingDiagnostic> ReadAsync(CancellationToken ct)
    {
        using var deadline = new CancellationTokenSource(Budget, time);
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct, deadline.Token);
        try
        {
            var snapshot = await source.ReadAsync(budget.Token);
            if (snapshot.StoredLinks < 0 || snapshot.UnlinkedStoredReferences < 0 || snapshot.Links.Count != Math.Min(Limit, snapshot.StoredLinks))
                return Unavailable("CHANGED");
            var counts = Classify(snapshot);
            var current = await source.ReadAsync(budget.Token);
            if (!Same(snapshot, current)) return Unavailable("CHANGED");
            var omitted = snapshot.StoredLinks - snapshot.Links.Count;
            var review = counts.ValidLinks != snapshot.Links.Count || snapshot.UnlinkedStoredReferences > 0 || omitted > 0;
            return new(omitted > 0 ? "INCOMPLETE" : "CHECKED", review ? "REQUIRED" : "NO_LOCAL_ISSUES_FOUND", "STORED_LOCAL_REGISTRY", Limit,
                new(snapshot.StoredLinks, snapshot.Links.Count, omitted, snapshot.UnlinkedStoredReferences), counts);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return Unavailable(); }
        catch (DbException) { return Unavailable(); }
    }

    private static bool Same(LocalMappingSnapshot first, LocalMappingSnapshot second) =>
        first.StoredLinks == second.StoredLinks && first.UnlinkedStoredReferences == second.UnlinkedStoredReferences
        && first.Links.SequenceEqual(second.Links) && first.References.SequenceEqual(second.References)
        && first.LiveCustomerIds.SequenceEqual(second.LiveCustomerIds);

    internal static AtlasMappingCounts Classify(LocalMappingSnapshot snapshot)
    {
        var valid = 0; var identities = 0; var missing = 0; var gone = 0; var invalid = 0; var unavailable = 0;
        var tuples = new Dictionary<(string Workspace, string Client), int>();
        foreach (var record in snapshot.References)
            if (record.PayloadBytes is <= 8192 && CustomerIdentityReferenceValidation.TryRead(record.Payload, out var reference)
                && CustomerIdentityReferenceValidation.IsCanonical(reference!, record.ExternalId))
            {
                var tuple = (reference!.WorkspaceId, reference.ClientId);
                tuples[tuple] = tuples.GetValueOrDefault(tuple) + 1;
            }
        foreach (var link in snapshot.Links)
        {
            if (link.System != CustomerIdentityContract.System || link.ExternalType != CustomerIdentityContract.ExternalType
                || link.EntityType != EntityTypes.Organization || link.EntityId == Guid.Empty || link.IdentityMatches != 1 || link.CustomerMatches != 1
                || link.ExternalId.Length != 64 || link.ExternalId.Any(c => !char.IsAsciiHexDigitLower(c))) { identities++; continue; }
            // Ordinal checks are explicit even when SQL matched a corrupt differently-cased value.
            var matches = snapshot.References.Where(record => record.ExternalId == link.ExternalId).Take(2).ToArray();
            if (matches.Length == 0)
            {
                // A SQL case-insensitive match is evidence of a corrupt reference, never a fallback trusted identity.
                if (snapshot.References.Any(record => string.Equals(record.ExternalId, link.ExternalId, StringComparison.OrdinalIgnoreCase))) invalid++;
                else missing++;
                continue;
            }
            if (matches.Length != 1) { invalid++; continue; }
            var record = matches[0];
            if (record.IsGone) { gone++; continue; }
            if (record.System != CustomerIdentityContract.System || record.ExternalType != CustomerIdentityContract.ExternalType
                || record.PayloadBytes is null or > 8192 || !CustomerIdentityReferenceValidation.TryRead(record.Payload, out var reference)
                || !CustomerIdentityReferenceValidation.IsCanonical(reference!, link.ExternalId)
                || tuples.GetValueOrDefault((reference!.WorkspaceId, reference.ClientId)) != 1) { invalid++; continue; }
            if (!snapshot.LiveCustomerIds.Contains(link.EntityId)) { unavailable++; continue; }
            valid++;
        }
        return new(valid, identities, missing, gone, invalid, unavailable);
    }
}
