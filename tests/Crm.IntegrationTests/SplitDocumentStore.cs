using System.Runtime.CompilerServices;
using Crm.SharedKernel.Documents;

namespace Crm.IntegrationTests;

/// <summary>
/// A document store for a test host whose maintenance switch must not reach the classes running beside it (DEV-13): the keys of
/// <c>operations/maintenance/</c> go to a store of the test's own, everything else — documents, the external effect journal,
/// reports — to the run's shared store. Reading the switch can be made to fail, as an outage of the store would.
/// </summary>
public sealed class SplitDocumentStore(IDocumentStore maintenance, IDocumentStore shared) : IDocumentStore
{
    private const string MaintenancePrefix = "operations/maintenance/";

    public bool FailMaintenanceReads { get; set; }

    public Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken) =>
        Route(key).PutAsync(key, content, mediaType, cancellationToken);

    public Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        Guard(key);
        return Route(key).ReadAsync(key, cancellationToken);
    }

    public async IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        Guard(prefix);
        await foreach (var item in Route(prefix).ListAsync(prefix, cancellationToken))
        {
            yield return item;
        }
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken) => Route(key).DeleteAsync(key, cancellationToken);

    private IDocumentStore Route(string key) => key.StartsWith(MaintenancePrefix, StringComparison.Ordinal) ? maintenance : shared;

    private void Guard(string key)
    {
        if (FailMaintenanceReads && key.StartsWith(MaintenancePrefix, StringComparison.Ordinal))
        {
            throw new IOException("Document storage is unavailable (test).");
        }
    }
}
