using System.Text;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>The folder store of development and tests (DEV-08): keys appear whole or not at all, and the first writer wins.</summary>
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
    public async Task Keys_that_would_leave_the_store_are_refused(string key)
    {
        var store = new FileSystemDocumentStore(_root);

        await Should.ThrowAsync<ArgumentException>(() => store.PutAsync(key, "%PDF"u8.ToArray(), "application/pdf", Ct));
        await Should.ThrowAsync<ArgumentException>(() => store.ReadAsync(key, Ct));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
