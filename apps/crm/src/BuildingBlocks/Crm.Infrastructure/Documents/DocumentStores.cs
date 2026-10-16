using System.Runtime.CompilerServices;
using Azure;
using Azure.Identity;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Crm.SharedKernel.Documents;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Documents;

public enum DocumentStoreProvider
{
    /// <summary>A folder on disk: development and tests. Refused in production, where a container's disk does not last.</summary>
    FileSystem,

    /// <summary>A private Blob Storage container reached with the app's managed identity (DEV-08).</summary>
    AzureBlob,
}

public sealed class DocumentStoreOptions
{
    public const string SectionName = "Documents";

    public DocumentStoreProvider Provider { get; set; } = DocumentStoreProvider.FileSystem;

    /// <summary>Folder of the file-system store; relative paths are taken from the content root.</summary>
    public string RootPath { get; set; } = "data/documents";

    /// <summary>https://&lt;account&gt;.blob.core.windows.net/&lt;container&gt; of the blob store.</summary>
    public string? BlobContainerUri { get; set; }

    /// <summary>Client id of the user-assigned managed identity; empty uses the default credential chain.</summary>
    public string? ManagedIdentityClientId { get; set; }
}

internal sealed class DocumentStoreOptionsValidation(IHostEnvironment environment) : IValidateOptions<DocumentStoreOptions>
{
    public ValidateOptionsResult Validate(string? name, DocumentStoreOptions options)
    {
        if (options.Provider == DocumentStoreProvider.AzureBlob && !Uri.TryCreate(options.BlobContainerUri, UriKind.Absolute, out _))
        {
            return ValidateOptionsResult.Fail("Documents:BlobContainerUri must be the address of the document container.");
        }

        // Issued documents are evidence: a production host never keeps them on a disk that disappears with the container.
        return options.Provider == DocumentStoreProvider.FileSystem && environment.IsProduction()
            ? ValidateOptionsResult.Fail("Documents:Provider FileSystem is for development and tests; production uses AzureBlob.")
            : ValidateOptionsResult.Success;
    }
}

/// <summary>
/// Files under a root folder; a key is a relative path; development and tests only. A write goes to a file of its own and is
/// then moved under the key without replacing anything, so a key appears complete or not at all (a process that dies halfway
/// leaves no half document under it) and two writers of one key end with the first one's bytes.
/// </summary>
public sealed class FileSystemDocumentStore(string root) : IDocumentStore
{
    // File.Move checks that the name is free and then renames, which two writers can both pass: within a process the step is
    // taken one writer at a time. Across processes (web and worker on a developer's machine) the window remains; they store
    // the same rendering of one snapshot there. Production uses the blob store, whose conditional upload is atomic.
    private static readonly Lock Placing = new();

    public async Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken)
    {
        var path = PathOf(key);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var aside = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await using (var file = new FileStream(aside, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await file.WriteAsync(content, cancellationToken);
            }

            try
            {
                lock (Placing)
                {
                    File.Move(aside, path, overwrite: false);
                }

                return new StoredObject(key, DocumentHashes.Sha256(content.Span), content.Length, Created: true);
            }
            catch (IOException) when (File.Exists(path))
            {
                var existing = await File.ReadAllBytesAsync(path, cancellationToken);
                return new StoredObject(key, DocumentHashes.Sha256(existing), existing.Length, Created: false);
            }
        }
        finally
        {
            File.Delete(aside);
        }
    }

    public async Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        var path = PathOf(key);
        return File.Exists(path) ? await File.ReadAllBytesAsync(path, cancellationToken) : null;
    }

    public async IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var full = Path.GetFullPath(root);
        if (!Directory.Exists(full))
        {
            yield break;
        }

        foreach (var path in Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = Path.GetRelativePath(full, path).Replace(Path.DirectorySeparatorChar, '/');
            if (key.StartsWith(prefix, StringComparison.Ordinal))
            {
                var info = new FileInfo(path);
                yield return new StoredObjectInfo(key, info.Length, new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero));
            }
        }

        await Task.CompletedTask;
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken)
    {
        File.Delete(PathOf(key));
        return Task.CompletedTask;
    }

    private string PathOf(string key)
    {
        DocumentKeys.Guard(key);
        var full = Path.GetFullPath(root);
        var path = Path.GetFullPath(Path.Combine(full, key));
        return path.StartsWith(full + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            ? path
            : throw new ArgumentException($"Document key '{key}' leaves the store.", nameof(key));
    }
}

/// <summary>
/// A private blob container (DEV-08). Uploads are conditional on the blob not existing (If-None-Match: *), so a key is never
/// overwritten. The SHA-256 is also written as blob metadata for operators; the store itself never trusts metadata, which
/// anyone with write access can change, and hashes the stored bytes when a key turns out to exist.
/// </summary>
public sealed class AzureBlobDocumentStore(BlobContainerClient container) : IDocumentStore
{
    public const string HashMetadata = "sha256";

    public async Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken)
    {
        DocumentKeys.Guard(key);
        var blob = container.GetBlobClient(key);
        var sha256 = DocumentHashes.Sha256(content.Span);
        try
        {
            await blob.UploadAsync(
                BinaryData.FromBytes(content),
                new BlobUploadOptions
                {
                    HttpHeaders = new BlobHttpHeaders { ContentType = mediaType },
                    Metadata = new Dictionary<string, string> { [HashMetadata] = sha256 },
                    Conditions = new BlobRequestConditions { IfNoneMatch = ETag.All },
                },
                cancellationToken);
            return new StoredObject(key, sha256, content.Length, Created: true);
        }
        catch (RequestFailedException ex) when (ex.Status is 409 or 412)
        {
            // 409 BlobAlreadyExists from a single upload, 412 ConditionNotMet when a large upload commits its blocks.
            var existing = (await blob.DownloadContentAsync(cancellationToken)).Value.Content.ToMemory();
            return new StoredObject(key, DocumentHashes.Sha256(existing.Span), existing.Length, Created: false);
        }
    }

    public async Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        DocumentKeys.Guard(key);
        try
        {
            return (await container.GetBlobClient(key).DownloadContentAsync(cancellationToken)).Value.Content.ToArray();
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        await foreach (var item in container.GetBlobsAsync(BlobTraits.None, BlobStates.None, prefix, cancellationToken))
        {
            yield return new StoredObjectInfo(item.Name, item.Properties.ContentLength ?? 0, item.Properties.LastModified ?? DateTimeOffset.MinValue);
        }
    }

    public async Task DeleteAsync(string key, CancellationToken cancellationToken)
    {
        DocumentKeys.Guard(key);
        await container.GetBlobClient(key).DeleteIfExistsAsync(cancellationToken: cancellationToken);
    }

    internal static AzureBlobDocumentStore Create(DocumentStoreOptions options) => new(new BlobContainerClient(
        new Uri(options.BlobContainerUri!),
        new DefaultAzureCredential(new DefaultAzureCredentialOptions { ManagedIdentityClientId = options.ManagedIdentityClientId })));
}

public static class DocumentKeys
{
    /// <summary>Keys are relative, slash-separated paths of letters, digits, '-', '_' and '.', without '..' segments.</summary>
    public static void Guard(string key)
    {
        if (key.Length is 0 or > 512 || key.StartsWith('/') || key.Contains("..", StringComparison.Ordinal) ||
            !key.All(c => char.IsAsciiLetterOrDigit(c) || c is '/' or '-' or '_' or '.'))
        {
            throw new ArgumentException($"Invalid document key '{key}'.", nameof(key));
        }
    }
}
