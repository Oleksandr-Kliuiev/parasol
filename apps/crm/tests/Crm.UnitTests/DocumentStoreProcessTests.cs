using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>Independent OS processes exercise the same store used by the web host and the worker.</summary>
public sealed class DocumentStoreProcessTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"crm-process-store-{Guid.NewGuid():N}");
    private readonly List<Process> _children = [];
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Eight_processes_racing_on_a_new_directory_publish_one_complete_document()
    {
        var store = new FileSystemDocumentStore(_root);
        const string key = "quotes/new/version/issued.pdf";
        var writers = Enumerable.Range(0, 8).Select(i => Start(key, $"writer-{i}")).ToArray();
        await Task.WhenAll(writers.Select(ReadyAsync));
        await Task.WhenAll(writers.Select(GoAsync));
        var results = await Task.WhenAll(writers.Select(ResultAsync));
        var bytes = (await store.ReadAsync(key, Ct))!;

        results.Count(r => r.Created).ShouldBe(1);
        results.ShouldAllBe(r => r.Sha256 == DocumentHashes.Sha256(bytes) && r.Length == bytes.Length);
        Enumerable.Range(0, 8).ShouldContain(i => bytes.SequenceEqual(Content($"writer-{i}")));
        (await store.ListAsync("quotes/", Ct).ToListAsync(Ct)).ShouldHaveSingleItem().Key.ShouldBe(key);
    }

    [Theory]
    [InlineData("Staged")]
    [InlineData("Linked")]
    [InlineData("Published")]
    public async Task Killing_a_writer_at_a_commit_boundary_preserves_first_published_bytes(string stage)
    {
        var store = new FileSystemDocumentStore(_root);
        const string key = "quotes/crash/issued.pdf";
        var interrupted = Start(key, "first", stage);
        await ReadyAsync(interrupted);
        await GoAsync(interrupted);
        (await LineAsync(interrupted)).ShouldBe(stage);
        var beforeCrash = await store.ReadAsync(key, Ct);
        if (stage == "Staged")
        {
            beforeCrash.ShouldBeNull();
        }
        else
        {
            beforeCrash.ShouldBe(Content("first"));
        }

        interrupted.Kill(entireProcessTree: true);
        await interrupted.WaitForExitAsync(Ct);
        var retry = Start(key, "retry");
        await ReadyAsync(retry);
        await GoAsync(retry);
        var result = await ResultAsync(retry);
        result.Created.ShouldBe(stage == "Staged");
        var expected = Content(stage == "Staged" ? "retry" : "first");
        (await new FileSystemDocumentStore(_root, createRoot: false).ReadAsync(key, Ct)).ShouldBe(expected);
        result.Sha256.ShouldBe(DocumentHashes.Sha256(expected));
        // Killed writers leave reserved staging files; consumers see only the issued document.
        (await store.ListAsync("quotes/", Ct).ToListAsync(Ct)).ShouldHaveSingleItem().Key.ShouldBe(key);
        Directory.GetFiles(_root, ".stage-*.tmp", SearchOption.AllDirectories).Length.ShouldBe(1);
    }

    private Process Start(string key, string writer, string stage = "None")
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") ??
            (Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } root ? Path.Combine(root, "dotnet") : "dotnet");
        var start = new ProcessStartInfo(host) { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in new[] { Path.Combine(AppContext.BaseDirectory, "DocumentStoreProbe", "Crm.DocumentStoreProbe.dll"), _root, key, writer, stage })
        {
            start.ArgumentList.Add(arg);
        }

        var process = Process.Start(start)!;
        _children.Add(process);
        return process;
    }

    private static byte[] Content(string writer) => Encoding.UTF8.GetBytes(writer + new string('x', 256 * 1024));

    private static async Task<string> LineAsync(Process process) =>
        await process.StandardOutput.ReadLineAsync(Ct).AsTask().WaitAsync(TimeSpan.FromSeconds(30), Ct) ??
        throw new InvalidOperationException(await process.StandardError.ReadToEndAsync(Ct));

    private static async Task ReadyAsync(Process process) => (await LineAsync(process)).ShouldBe("Ready");

    private static async Task GoAsync(Process process)
    {
        await process.StandardInput.WriteLineAsync();
        await process.StandardInput.FlushAsync(Ct);
    }

    private static async Task<StoredObject> ResultAsync(Process process)
    {
        var result = JsonSerializer.Deserialize<StoredObject>(await LineAsync(process))!;
        await process.WaitForExitAsync(Ct).WaitAsync(TimeSpan.FromSeconds(30), Ct);
        process.ExitCode.ShouldBe(0, await process.StandardError.ReadToEndAsync(Ct));
        return result;
    }

    public void Dispose()
    {
        foreach (var child in _children)
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit(5000);
            }

            child.Dispose();
        }

        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
