using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Crm.Infrastructure.Documents;

/// <summary>Local POSIX filesystem operations; no copy/overwrite fallback on unsupported volumes.</summary>
internal static partial class PosixDocumentFiles
{
    private const int AlreadyExists = 17;
    private const int Interrupted = 4;

    internal static bool Publish(string source, string destination)
    {
        // linkat with flags=0 never follows a source symlink and never replaces an existing destination.
        var currentDirectory = OperatingSystem.IsMacOS() ? -2 : -100;
        if (LinkAt(currentDirectory, source, currentDirectory, destination, 0) == 0)
        {
            return true;
        }

        var error = Marshal.GetLastPInvokeError();
        return error == AlreadyExists ? false : throw Failure("publish", error);
    }

    internal static void SyncDirectory(string path)
    {
        using var handle = OpenRead(path, directory: true);
        int error;
        do
        {
            if (FSync(handle) == 0)
            {
                return;
            }

            error = Marshal.GetLastPInvokeError();
        }
        while (error == Interrupted);

        throw Failure("sync directory", error);
    }

    internal static void Delete(string path)
    {
        if (Unlink(path) != 0)
        {
            var error = Marshal.GetLastPInvokeError();
            if (error != 2)
            {
                throw Failure("delete", error);
            }
        }
    }

    internal static SafeFileHandle OpenRead(string path, bool directory = false)
    {
        // O_RDONLY | O_CLOEXEC | O_NOFOLLOW; directory descriptors additionally require O_DIRECTORY.
        // Linux aarch64 overrides O_DIRECTORY/O_NOFOLLOW from the generic/x86-64 fcntl ABI.
        // See glibc sysdeps/unix/sysv/linux/{aarch64/bits/fcntl.h,bits/fcntl-linux.h}.
        var (closeOnExec, noFollow, directoryOnly, nonBlocking) = OperatingSystem.IsMacOS()
            ? (0x1000000, 0x100, 0x100000, 4)
            : RuntimeInformation.ProcessArchitecture switch
            {
                Architecture.X64 => (0x80000, 0x20000, 0x10000, 0x800),
                Architecture.Arm64 => (0x80000, 0x8000, 0x4000, 0x800),
                _ => throw new PlatformNotSupportedException("Document storage supports Linux x64/arm64 and macOS."),
            };
        var flags = closeOnExec | noFollow | (directory ? directoryOnly : nonBlocking);
        var descriptor = Open(path, flags);
        if (descriptor < 0)
        {
            var error = Marshal.GetLastPInvokeError();
            throw error == 2 ? new FileNotFoundException("Document path is unavailable.") : Failure("open", error);
        }

        return new SafeFileHandle(new IntPtr(descriptor), ownsHandle: true);
    }

    private static IOException Failure(string operation, int error) =>
        new($"Document storage could not {operation} (errno {error}).", new Win32Exception(error));

    [LibraryImport("libc", EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Open(string path, int flags);

    [LibraryImport("libc", EntryPoint = "linkat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int LinkAt(int sourceDirectory, string source, int destinationDirectory, string destination, int flags);

    [LibraryImport("libc", EntryPoint = "fsync", SetLastError = true)]
    private static partial int FSync(SafeFileHandle descriptor);

    [LibraryImport("libc", EntryPoint = "unlink", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Unlink(string path);
}
