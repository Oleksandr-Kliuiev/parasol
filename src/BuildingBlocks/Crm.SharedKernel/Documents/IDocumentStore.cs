namespace Crm.SharedKernel.Documents;

/// <summary>
/// Storage for issued documents (DEV-08). A key names one object for good: writing a key that already holds an object keeps
/// that object — a retry finds it and adopts it — so an issued document is never replaced. Objects are reached only through
/// the application; the store hands out no addresses.
/// </summary>
public interface IDocumentStore
{
    /// <summary>Stores <paramref name="content"/> under <paramref name="key"/> unless the key already holds an object.</summary>
    Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken);

    /// <summary>The object's bytes, or null when the key holds nothing.</summary>
    Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken);

    IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, CancellationToken cancellationToken);

    /// <summary>Removes an object; only orphan cleanup calls it, for objects no record references.</summary>
    Task DeleteAsync(string key, CancellationToken cancellationToken);
}

/// <summary>
/// The object under a key after a write. <see cref="Created"/> is false when the key already held one; the hash and length
/// then describe that existing object, not the bytes offered.
/// </summary>
public sealed record StoredObject(string Key, string Sha256, long Length, bool Created);

public sealed record StoredObjectInfo(string Key, long Length, DateTimeOffset LastModified);

public static class DocumentHashes
{
    /// <summary>Lower-case hex SHA-256, the form documents record and compare.</summary>
    public static string Sha256(ReadOnlySpan<byte> content) =>
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(content));
}
