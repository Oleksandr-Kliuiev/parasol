using System.Runtime.CompilerServices;
using Crm.SharedKernel.Documents;

namespace Crm.Infrastructure.Documents;

/// <summary>
/// Private persistent local volume shared by web and worker. Flush complete bytes, atomically link without replacing,
/// then sync the directory before acknowledging. The containing directory tree must be writable only by the service account.
/// </summary>
public sealed class FileSystemDocumentStore : IDocumentStore
{
    private readonly string _root;
    private readonly Action<DocumentWriteStage>? _afterStage;
    private readonly string? _volumeId;

    public FileSystemDocumentStore(string root, bool createRoot = true, string? volumeId = null)
        : this(root, createRoot, null, volumeId)
    {
    }

    // A process-test seam: kill a writer at each crash boundary without timing assumptions or production switches.
    internal FileSystemDocumentStore(string root, bool createRoot, Action<DocumentWriteStage>? afterStage, string? volumeId = null)
    {
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()))
        {
            throw new PlatformNotSupportedException("Document storage requires Linux or macOS.");
        }

        _root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        _volumeId = volumeId;
        if (createRoot)
        {
            Directory.CreateDirectory(_root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        GuardRoot();
        ProbeVolume();
        CleanupStaging();
        _afterStage = afterStage;
    }

    public async Task<StoredObject> PutAsync(string key, ReadOnlyMemory<byte> content, string mediaType, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = PathOf(key);
        var directory = Path.GetDirectoryName(path)!;
        if (OperatingSystem.IsWindows() || (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()))
        {
            throw new PlatformNotSupportedException();
        }

        Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        GuardPath(path);
        // Also sync existing ancestors: another process may have created a directory but died before syncing its parent.
        SyncAncestors(directory);
        var aside = Path.Combine(directory, $".stage-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var file = new FileStream(aside, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
            }))
            {
                await file.WriteAsync(content, cancellationToken);
                file.Flush(flushToDisk: true);
            }

            _afterStage?.Invoke(DocumentWriteStage.Staged);
            cancellationToken.ThrowIfCancellationRequested();
            var created = PosixDocumentFiles.Publish(aside, path);
            _afterStage?.Invoke(DocumentWriteStage.Linked);
            // An adopting writer also syncs: the winner may have died just after linking, before its directory sync.
            PosixDocumentFiles.SyncDirectory(directory);
            _afterStage?.Invoke(DocumentWriteStage.Published);
            var stored = await ReadAsync(key, cancellationToken) ?? throw new IOException("The published document disappeared.");
            return new StoredObject(key, DocumentHashes.Sha256(stored), stored.Length, created);
        }
        finally
        {
            File.Delete(aside);
            PosixDocumentFiles.SyncDirectory(directory);
        }
    }

    public async Task<byte[]?> ReadAsync(string key, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = PathOf(key);
        try
        {
            using var handle = PosixDocumentFiles.OpenRead(path);
            await using var file = new FileStream(handle, FileAccess.Read);
            if (!file.CanSeek)
            {
                throw new IOException("Document path is not a regular file.");
            }

            using var output = new MemoryStream();
            await file.CopyToAsync(output, cancellationToken);
            return output.ToArray();
        }
        catch (FileNotFoundException)
        {
            // Only a missing object is null; a missing volume, permission error or unreadable object must fail closed.
            GuardRoot();
            return null;
        }
    }

    public async IAsyncEnumerable<StoredObjectInfo> ListAsync(string prefix, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (prefix.Length > 0)
        {
            DocumentKeys.Guard(prefix.EndsWith('/') ? prefix[..^1] : prefix);
        }

        GuardRoot();
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = false, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var path in Directory.EnumerateFiles(_root, "*", options))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var key = Path.GetRelativePath(_root, path).Replace(Path.DirectorySeparatorChar, '/');
            if (!IsInternal(Path.GetFileName(path)) && key.StartsWith(prefix, StringComparison.Ordinal))
            {
                GuardPath(path);
                var info = new FileInfo(path);
                if (info.Exists)
                {
                    // Legacy temporary keys remain visible to the existing age/reference-aware orphan cleanup.
                    yield return new StoredObjectInfo(key, info.Length, new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero));
                }
            }
        }

        await Task.CompletedTask;
    }

    public Task DeleteAsync(string key, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var path = PathOf(key);
        try
        {
            PosixDocumentFiles.Delete(path);
            PosixDocumentFiles.SyncDirectory(Path.GetDirectoryName(path)!);
        }
        catch (IOException error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            GuardRoot();
        }

        return Task.CompletedTask;
    }

    private string PathOf(string key)
    {
        DocumentKeys.Guard(key);
        var path = Path.Combine(_root, key);
        GuardRoot();
        GuardPath(path);
        return path;
    }

    private void GuardRoot()
    {
        RejectLink(_root);
        using var handle = PosixDocumentFiles.OpenRead(_root, directory: true);
        if (_volumeId is not null)
        {
            var marker = Path.Combine(_root, ".parasol-volume");
            RejectLink(marker);
            if (File.ReadAllText(marker).Trim() != _volumeId)
            {
                throw new IOException("Document volume identity does not match Documents:VolumeId.");
            }
        }
    }

    private void GuardPath(string path)
    {
        // No application operation creates symlinks. The private tree must never be modified by untrusted local users.
        for (var current = path; current != _root; current = Path.GetDirectoryName(current)!)
        {
            RejectLink(current);
        }
    }

    private static void RejectLink(string path)
    {
        if (new FileInfo(path).LinkTarget is not null)
        {
            throw new IOException("Symbolic links are not allowed in the document store.");
        }
    }

    private void SyncAncestors(string directory)
    {
        for (var current = directory; ; current = Path.GetDirectoryName(current)!)
        {
            PosixDocumentFiles.SyncDirectory(current);
            if (current == _root)
            {
                return;
            }
        }
    }

    private static bool IsInternal(string name) => name == ".parasol-volume" ||
        name.StartsWith(".stage-", StringComparison.Ordinal) || name.StartsWith(".probe-", StringComparison.Ordinal);

    private void CleanupStaging()
    {
        var cutoff = DateTime.UtcNow.AddDays(-7);
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = false, AttributesToSkip = FileAttributes.ReparsePoint };
        foreach (var path in Directory.EnumerateFiles(_root, ".stage-*.tmp", options))
        {
            GuardPath(path);
            if (File.GetLastWriteTimeUtc(path) < cutoff)
            {
                // Only reserved staging names; removing an extra hard link cannot delete a published document.
                PosixDocumentFiles.Delete(path);
                PosixDocumentFiles.SyncDirectory(Path.GetDirectoryName(path)!);
            }
        }
    }

    private void ProbeVolume()
    {
        var source = Path.Combine(_root, $".probe-{Guid.NewGuid():N}");
        var destination = source + ".linked";
        try
        {
            using (var file = new FileStream(source, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                file.WriteByte(1);
                file.Flush(flushToDisk: true);
            }

            if (!PosixDocumentFiles.Publish(source, destination) || PosixDocumentFiles.Publish(source, destination))
            {
                throw new IOException("Document volume does not support create-only publication.");
            }

            PosixDocumentFiles.SyncDirectory(_root);
        }
        finally
        {
            File.Delete(source);
            File.Delete(destination);
            PosixDocumentFiles.SyncDirectory(_root);
        }
    }
}

internal enum DocumentWriteStage
{
    Staged,
    Linked,
    Published,
}
