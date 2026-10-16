using System.Text;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>The VPS store: keys appear whole or not at all, and the first writer wins.</summary>
public sealed class FileSystemDocumentStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"crm-store-{Guid.NewGuid():N}");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Writers_racing_for_one_key_leave_one_whole_file_and_all_learn_its_hash()
    {
        var store = new FileSystemDocumentStore(_root);
        const string key = "quotes/a/b/c.pdf";
        var contents = Enumerable.Range(0, 16).Select(i => Encoding.ASCII.GetBytes($"%PDF-1.4 writer {i} " + new string('x', 64 * 1024))).ToList();

        var attempts = await Task.WhenAll(contents.Select(content => Task.Run(() => store.PutAsync(key, content, "application/pdf", Ct), Ct)));

        var stored = (await store.ReadAsync(key, Ct))!;
        attempts.Count(a => a.Created).ShouldBe(1);
        attempts.ShouldAllBe(a => a.Sha256 == DocumentHashes.Sha256(stored) && a.Length == stored.Length);
        contents.ShouldContain(c => c.SequenceEqual(stored));
        Directory.GetFiles(Path.Combine(_root, "quotes", "a", "b")).ShouldBe([Path.Combine(_root, "quotes", "a", "b", "c.pdf")]);
    }

    [Fact]
    public async Task What_a_writer_that_died_halfway_left_behind_is_not_the_document()
    {
        var store = new FileSystemDocumentStore(_root);
        const string key = "quotes/a/b/c.pdf";
        var folder = Path.Combine(_root, "quotes", "a", "b");
        Directory.CreateDirectory(folder);
        await File.WriteAllBytesAsync(Path.Combine(folder, $"c.pdf.{Guid.NewGuid():N}.tmp"), "%PDF-1.4 half"u8.ToArray(), Ct);
        var whole = Encoding.ASCII.GetBytes("%PDF-1.4 the whole document");

        var written = await store.PutAsync(key, whole, "application/pdf", Ct);

        written.Created.ShouldBeTrue();
        (await store.ReadAsync(key, Ct)).ShouldBe(whole);
        // The leftover is listed, so the orphan cleanup removes it once it is old enough.
        (await store.ListAsync("quotes/", Ct).ToListAsync(Ct)).Count.ShouldBe(2);
    }

    [Theory]
    [InlineData("../outside.pdf")]
    [InlineData("quotes/../../outside.pdf")]
    [InlineData("/etc/passwd")]
    [InlineData("quotes/a b.pdf")]
    [InlineData("quotes//a.pdf")]
    [InlineData("quotes/./a.pdf")]
    [InlineData("quotes/a.pdf/")]
    [InlineData(".")]
    [InlineData("")]
    [InlineData(".parasol-volume")]
    [InlineData("quotes/.stage-private.tmp")]
    [InlineData(".probe-private")]
    public async Task Keys_that_would_leave_the_store_are_refused(string key)
    {
        var store = new FileSystemDocumentStore(_root);

        await Should.ThrowAsync<ArgumentException>(() => store.PutAsync(key, "%PDF"u8.ToArray(), "application/pdf", Ct));
        await Should.ThrowAsync<ArgumentException>(() => store.ReadAsync(key, Ct));
        await Should.ThrowAsync<ArgumentException>(() => store.DeleteAsync(key, Ct));
    }

    [Fact]
    public async Task Cancellation_before_publication_leaves_no_object_or_temporary_file()
    {
        using var cancellation = new CancellationTokenSource();
        var store = new FileSystemDocumentStore(_root, true, stage =>
        {
            if (stage == DocumentWriteStage.Staged)
            {
                cancellation.Cancel();
            }
        });
        await Should.ThrowAsync<OperationCanceledException>(() => store.PutAsync("quotes/cancelled.pdf", "whole"u8.ToArray(), "application/pdf", cancellation.Token));
        (await store.ReadAsync("quotes/cancelled.pdf", Ct)).ShouldBeNull();
        (await store.ListAsync("", Ct).ToListAsync(Ct)).ShouldBeEmpty();
    }

    [Fact]
    public async Task Losing_the_volume_fails_reads_writes_lists_and_deletes_without_recreating_it()
    {
        var store = new FileSystemDocumentStore(_root);
        Directory.Delete(_root);
        await Should.ThrowAsync<IOException>(() => store.ReadAsync("quotes/missing.pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.PutAsync("quotes/missing.pdf", "bytes"u8.ToArray(), "application/pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.ListAsync("quotes/", Ct).ToListAsync(Ct).AsTask());
        await Should.ThrowAsync<IOException>(() => store.DeleteAsync("quotes/missing.pdf", Ct));
        Directory.Exists(_root).ShouldBeFalse();
    }

    [Fact]
    public async Task Symlinked_objects_and_directories_cannot_escape_the_private_store()
    {
        var store = new FileSystemDocumentStore(_root);
        var outside = Path.Combine(Path.GetTempPath(), $"crm-outside-{Guid.NewGuid():N}");
        Directory.CreateDirectory(outside);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(outside, "private.pdf"), "outside", Ct);
            Directory.CreateSymbolicLink(Path.Combine(_root, "linked"), outside);
            File.CreateSymbolicLink(Path.Combine(_root, "file.pdf"), Path.Combine(outside, "private.pdf"));
            foreach (var key in new[] { "linked/private.pdf", "file.pdf" })
            {
                await Should.ThrowAsync<IOException>(() => store.ReadAsync(key, Ct));
                await Should.ThrowAsync<IOException>(() => store.PutAsync(key, "changed"u8.ToArray(), "application/pdf", Ct));
                await Should.ThrowAsync<IOException>(() => store.DeleteAsync(key, Ct));
            }

            (await store.ListAsync("", Ct).ToListAsync(Ct)).ShouldBeEmpty();
            (await File.ReadAllTextAsync(Path.Combine(outside, "private.pdf"), Ct)).ShouldBe("outside");
        }
        finally
        {
            Directory.Delete(outside, recursive: true);
        }
    }

    [Fact]
    public async Task A_blocking_file_is_an_error_not_a_successful_duplicate_or_missing_object()
    {
        var store = new FileSystemDocumentStore(_root);
        await File.WriteAllTextAsync(Path.Combine(_root, "quotes"), "blocked", Ct);
        await Should.ThrowAsync<IOException>(() => store.PutAsync("quotes/issued.pdf", "bytes"u8.ToArray(), "application/pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.ReadAsync("quotes/issued.pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.DeleteAsync("quotes/issued.pdf", Ct));
    }

    [Fact]
    public async Task A_missing_or_wrong_volume_marker_fails_closed_even_when_the_mount_directory_exists()
    {
        Directory.CreateDirectory(_root);
        var volumeId = Guid.NewGuid().ToString("D");
        Should.Throw<IOException>(() => new FileSystemDocumentStore(_root, false, volumeId));
        var marker = Path.Combine(_root, ".parasol-volume");
        await File.WriteAllTextAsync(marker, volumeId, Ct);
        var store = new FileSystemDocumentStore(_root, false, volumeId);
        await store.PutAsync("issued.pdf", "original"u8.ToArray(), "application/pdf", Ct);
        await File.WriteAllTextAsync(marker, Guid.NewGuid().ToString("D"), Ct);
        await Should.ThrowAsync<IOException>(() => store.ReadAsync("issued.pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.PutAsync("new.pdf", "other"u8.ToArray(), "application/pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.DeleteAsync("issued.pdf", Ct));
        await Should.ThrowAsync<IOException>(() => store.ListAsync("", Ct).ToListAsync(Ct).AsTask());
        (await File.ReadAllTextAsync(Path.Combine(_root, "issued.pdf"), Ct)).ShouldBe("original");
    }

    [Fact]
    public async Task Restart_removes_only_aged_reserved_staging_and_preserves_documents_and_recent_staging()
    {
        var store = new FileSystemDocumentStore(_root);
        await store.PutAsync("operations/effects/issued.json", "{}"u8.ToArray(), "application/json", Ct);
        var parent = Path.Combine(_root, "operations", "effects");
        var oldStage = Path.Combine(parent, ".stage-old.tmp");
        var freshStage = Path.Combine(parent, ".stage-fresh.tmp");
        await File.WriteAllTextAsync(oldStage, "partial", Ct);
        await File.WriteAllTextAsync(freshStage, "partial", Ct);
        File.SetLastWriteTimeUtc(oldStage, DateTime.UtcNow.AddDays(-8));
        File.SetLastWriteTimeUtc(Path.Combine(parent, "issued.json"), DateTime.UtcNow.AddDays(-8));

        var restarted = new FileSystemDocumentStore(_root, false);
        File.Exists(oldStage).ShouldBeFalse();
        File.Exists(freshStage).ShouldBeTrue();
        (await restarted.ReadAsync("operations/effects/issued.json", Ct)).ShouldBe("{}"u8.ToArray());
        (await restarted.ListAsync("operations/", Ct).ToListAsync(Ct)).ShouldHaveSingleItem().Key.ShouldBe("operations/effects/issued.json");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
