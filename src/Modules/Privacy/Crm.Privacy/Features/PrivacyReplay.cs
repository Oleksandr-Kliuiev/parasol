using System.Security.Cryptography;
using System.Text;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;
using Crm.Privacy.Persistence;
using Crm.SharedKernel.Documents;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.Privacy.Features;

/// <summary>
/// Whether a database restore left erasures to apply again (DEV-11-AC06): the document store — outside the database — holds a
/// deletion manifest the database does not know. Checked at most once a minute per process; when the store cannot be read
/// the last answer stands (the store's outage must not take the CRM down; a restore is an operator's procedure that runs the
/// replay explicitly, runbook 13).
/// </summary>
internal sealed class PrivacyReplayGate(IServiceScopeFactory scopes, TimeProvider time, ILogger<PrivacyReplayGate> logger) : IPrivacyReplayGate, IDisposable
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);
    private readonly SemaphoreSlim _check = new(1, 1);
    private (bool Pending, DateTimeOffset At)? _last;

    public async Task<bool> IsReplayPendingAsync(CancellationToken cancellationToken)
    {
        if (_last is { } last && time.GetUtcNow() - last.At < CacheFor)
        {
            return last.Pending;
        }

        await _check.WaitAsync(cancellationToken);
        try
        {
            if (_last is { } fresh && time.GetUtcNow() - fresh.At < CacheFor)
            {
                return fresh.Pending;
            }

            await using var scope = scopes.CreateAsyncScope();
            var pending = await UnknownManifestsAsync(
                scope.ServiceProvider.GetRequiredService<PrivacyDbContext>(), scope.ServiceProvider.GetRequiredService<IDocumentStore>(),
                await scope.ServiceProvider.GetRequiredService<SuppressionHasher>().InstallationAsync(cancellationToken), cancellationToken);
            _last = (pending.Count > 0, time.GetUtcNow());
            return pending.Count > 0;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning("The deletion manifests in the document store could not be compared with the database ({Error}).", ex.GetType().Name);
            return _last?.Pending ?? false;
        }
        finally
        {
            _check.Release();
        }
    }

    /// <summary>Forgets the cached answer: after a replay, or when a test changes the store or the database under it.</summary>
    public void Invalidate() => _last = null;

    public void Dispose() => _check.Dispose();

    /// <summary>Keys of this installation's manifests in the store that the database has no row for.</summary>
    internal static async Task<IReadOnlyList<(Guid Id, string Key)>> UnknownManifestsAsync(
        PrivacyDbContext db, IDocumentStore store, string installation, CancellationToken ct)
    {
        var known = (await db.ErasureManifests.AsNoTracking().Select(m => m.Id).ToListAsync(ct)).ToHashSet();
        var unknown = new List<(Guid, string)>();
        await foreach (var item in store.ListAsync(PrivacyCaseService.ManifestFolder(installation), ct))
        {
            var name = Path.GetFileNameWithoutExtension(item.Key);
            if (Guid.TryParseExact(name, "N", out var id) && !known.Contains(id))
            {
                unknown.Add((id, item.Key));
            }
        }

        return unknown;
    }
}

public sealed record ReplayResult(int Stored, int Replayed, int Records);

/// <summary>
/// After a restore: applies again, module by module, every erasure whose manifest is in the document store but not in the
/// database, restores its suppressions, its manifest row and its case, and writes to the store the manifests that never got
/// there. Idempotent; a crash midway is finished by the next run (the manifest row is written last).
/// </summary>
public sealed class PrivacyReplayJob
{
    public const string JobId = "privacy-replay";

    private readonly PrivacyDbContext db;
    private readonly IDocumentStore store;
    private readonly IEnumerable<IPersonalDataContributor> contributors;
    private readonly PrivacyCaseService cases;
    private readonly PrivacyReplayGate gate;
    private readonly SuppressionHasher hasher;
    private readonly TimeProvider time;
    private readonly ILogger<PrivacyReplayJob> logger;

    internal PrivacyReplayJob(
        PrivacyDbContext db, IDocumentStore store, IEnumerable<IPersonalDataContributor> contributors, PrivacyCaseService cases,
        PrivacyReplayGate gate, SuppressionHasher hasher, TimeProvider time, ILogger<PrivacyReplayJob> logger)
    {
        this.db = db;
        this.store = store;
        this.contributors = contributors;
        this.cases = cases;
        this.gate = gate;
        this.hasher = hasher;
        this.time = time;
        this.logger = logger;
    }

    public async Task<ReplayResult> RunAsync(CancellationToken cancellationToken)
    {
        var stored = 0;
        foreach (var unstored in await db.ErasureManifests.Where(m => m.StoredAt == null).ToListAsync(cancellationToken))
        {
            await cases.StoreManifestAsync(unstored, cancellationToken);
            stored += unstored.StoredAt is null ? 0 : 1;
        }

        int replayed = 0, records = 0;
        var installation = await hasher.InstallationAsync(cancellationToken);
        foreach (var (id, key) in await PrivacyReplayGate.UnknownManifestsAsync(db, store, installation, cancellationToken))
        {
            if (await store.ReadAsync(key, cancellationToken) is not { } content ||
                ManifestContent.Parse(Encoding.UTF8.GetString(content)) is not { } document || document.ManifestId != id ||
                document.Installation != installation)
            {
                logger.LogError("Deletion manifest {Key} cannot be read; erasures it describes are not applied again until an operator checks it.", key);
                continue;
            }

            foreach (var contributor in contributors)
            {
                var part = document.Records.Where(r => r.Record.Module == contributor.Module).ToList();
                if (part.Count > 0)
                {
                    records += await contributor.ReapplyAsync(part, document.CaseNumber, cancellationToken);
                }
            }

            await RestorePrivacyRecordsAsync(document, key, content, cancellationToken);
            replayed++;
            logger.LogWarning("PRIVACY_REPLAY {Case} {Manifest}: an erasure lost by a database restore was applied again.", document.CaseNumber, document.ManifestId);
        }

        gate.Invalidate();
        return new ReplayResult(stored, replayed, records);
    }

    private async Task RestorePrivacyRecordsAsync(ManifestContent.Document document, string key, byte[] content, CancellationToken ct)
    {
        foreach (var entry in document.Suppressions)
        {
            if (!await db.Suppressions.AnyAsync(s => s.Kind == entry.Kind && s.Value == entry.Value && s.LiftedAt == null, ct))
            {
                db.Suppressions.Add(Suppression.For(entry.Kind, entry.Value, document.CaseId));
            }
        }

        var sha = Convert.ToHexStringLower(SHA256.HashData(content));
        var receipt = ManifestContent.Receipt(document, sha);
        if (await db.Cases.SingleOrDefaultAsync(c => c.Id == document.CaseId, ct) is { } privacyCase)
        {
            if (privacyCase.Status != PrivacyCaseStatus.Completed)
            {
                privacyCase.CompleteErasure(receipt, null, document.ExecutedAt);
            }
        }
        else
        {
            db.Cases.Add(PrivacyCase.RestoredFromManifest(document.CaseId, document.CaseNumber, document.SubjectKind, document.SubjectId, document.ExecutedAt, receipt));
        }

        var manifest = ErasureManifest.Replayed(
            document.ManifestId, document.CaseId, document.CaseNumber, document.ExecutedAt, Encoding.UTF8.GetString(content), sha, key, time.GetUtcNow());
        db.ErasureManifests.Add(manifest);
        db.ErasedRecords.AddRange(PrivacyCaseService.ErasedRows(manifest.Id, document.Records));
        await db.SaveChangesAsync(ct);
    }
}
