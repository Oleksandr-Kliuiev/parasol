using System.Collections.Concurrent;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;

namespace Crm.IntegrationTests;

/// <summary>
/// The document store of the test run (DEV-08): a folder of its own, with failures a test switches on for the keys of one
/// quote only, so classes running in parallel are not affected.
/// </summary>
public sealed class TestDocumentStore : IDocumentStore
{
    private readonly ConcurrentDictionary<string, StoreFailure> _failures = new(StringComparer.Ordinal);

    public TestDocumentStore()
    {
        Root = Path.Combine(Path.GetTempPath(), $"crm-documents-{Guid.NewGuid():N}");
        Inner = new FileSystemDocumentStore(Root);
        File.WriteAllText(Path.Combine(Root, ".parasol-volume"), VolumeId);
    }

    public string VolumeId { get; } = Guid.NewGuid().ToString("D");

    public string Root { get; }

    public FileSystemDocumentStore Inner { get; }

    /// <summary>Writes of keys containing <paramref name="fragment"/> fail as chosen until <see cref="Heal"/>.</summary>
    public void Fail(string fragment, StoreFailure failure) => _failures[fragment] = failure;

    public void Heal(string fragment) => _failures.TryRemove(fragment, out _);

    public string PathOf(string key) => Path.Combine(Root, key.Replace('/', Path.DirectorySeparatorChar));

    public async Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken)
    {
        var failure = _failures.FirstOrDefault(f => key.Contains(f.Key, StringComparison.Ordinal)).Value;
        if (failure == StoreFailure.BeforeWrite)
        {
            throw new IOException("Document storage is unavailable (test).");
        }

        var stored = await Inner.PutAsync(key, content, mediaType, cancellationToken);
        return failure == StoreFailure.AfterWrite
            ? throw new IOException("The object was stored, then the connection dropped before the answer (test).")
            : stored;
    }

    public Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken) => Inner.ReadAsync(key, cancellationToken);

    public IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, CancellationToken cancellationToken) => Inner.ListAsync(prefix, cancellationToken);

    public Task DeleteAsync(string key, CancellationToken cancellationToken) => Inner.DeleteAsync(key, cancellationToken);
}

public enum StoreFailure
{
    None,

    /// <summary>Nothing is stored and the write fails.</summary>
    BeforeWrite,

    /// <summary>The object is stored, but the caller never learns it (the process or the connection died in between).</summary>
    AfterWrite,
}
