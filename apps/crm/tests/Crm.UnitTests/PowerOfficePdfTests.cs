using System.IO.Compression;
using System.Text;
using Crm.Billing.Domain;
using Crm.Integrations.PowerOffice;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

public class PowerOfficePdfTests
{
    private static readonly byte[] Pdf = Encoding.ASCII.GetBytes("%PDF-1.7\nsynthetic test envelope\n%%EOF\n");

    [Fact]
    public async Task Zip_preserves_each_pdf_and_its_source_name()
    {
        var files = await PowerOfficePdfArchive.ReadAsync(Zip(("invoice.pdf", Pdf), ("folder/credit.PDF", Pdf)), CancellationToken.None);
        files.Select(f => f.SourceName).ShouldBe(["invoice.pdf", "folder/credit.PDF"]);
        files.ShouldAllBe(f => f.Content.SequenceEqual(Pdf));
    }

    [Theory]
    [InlineData("../invoice.pdf")]
    [InlineData("/invoice.pdf")]
    [InlineData("folder/../invoice.pdf")]
    [InlineData("folder\\invoice.pdf")]
    [InlineData("https:invoice.pdf")]
    [InlineData("invoice.txt")]
    [InlineData("folder//invoice.pdf")]
    public async Task Unsafe_or_non_pdf_names_are_never_extracted(string name) =>
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip((name, Pdf)), CancellationToken.None));

    [Theory]
    [InlineData("<html>upstream error</html>")]
    [InlineData("%PDF-1.7\ntruncated synthetic content")]
    [InlineData("%PDF-9.9\nsynthetic\n%%EOF")]
    [InlineData("%PDF-1.7\nsynthetic\n%%EOF\nextra")]
    public async Task Invalid_or_truncated_pdf_is_rejected(string content) =>
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip(("invoice.pdf", Encoding.ASCII.GetBytes(content))), CancellationToken.None));

    [Fact]
    public async Task Duplicate_names_and_empty_zip_fail()
    {
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip(("invoice.pdf", Pdf), ("invoice.pdf", Pdf)), CancellationToken.None));
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip(), CancellationToken.None));
    }

    [Fact]
    public async Task Entry_count_and_expanded_member_size_are_bounded()
    {
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip(Enumerable.Range(0, 21).Select(i => ($"{i}.pdf", Pdf)).ToArray()), CancellationToken.None));
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(Zip(("large.pdf", new byte[PdfContent.MaxLength + 1])), CancellationToken.None));
    }

    [Fact]
    public async Task Corrupt_stored_zip_member_fails_crc_even_when_pdf_envelope_remains()
    {
        var zip = Zip(("invoice.pdf", Pdf));
        var marker = Encoding.ASCII.GetBytes("synthetic");
        var index = zip.AsSpan().IndexOf(marker);
        index.ShouldBeGreaterThan(0);
        zip[index] ^= 1;
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(zip, CancellationToken.None));
    }

    [Fact]
    public async Task Cancellation_and_truncated_zip_cannot_publish_partial_files()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Should.ThrowAsync<OperationCanceledException>(() => PowerOfficePdfArchive.ReadAsync(Zip(("invoice.pdf", Pdf)), cts.Token));
        var zip = Zip(("invoice.pdf", Pdf));
        await Should.ThrowAsync<InvalidDataException>(() => PowerOfficePdfArchive.ReadAsync(zip[..^10], CancellationToken.None));
    }

    [Fact]
    public void Content_addressing_is_stable_for_replay_and_separate_per_invoice()
    {
        var id = Guid.NewGuid();
        var first = InvoiceDocument.Create(id, "invoice.pdf", Pdf, DateTimeOffset.UtcNow);
        var replay = InvoiceDocument.Create(id, "invoice.pdf", Pdf, DateTimeOffset.UtcNow);
        var other = InvoiceDocument.Create(Guid.NewGuid(), "invoice.pdf", Pdf, DateTimeOffset.UtcNow);
        first.ObjectKey.ShouldBe(replay.ObjectKey);
        first.ContentSha256.ShouldBe(DocumentHashes.Sha256(Pdf));
        first.Length.ShouldBe(Pdf.Length);
        first.ObjectKey.ShouldNotBe(other.ObjectKey);
        Should.Throw<InvalidOperationException>(() => InvoiceDocument.Create(Guid.Empty, "invoice.pdf", Pdf, DateTimeOffset.UtcNow));
    }

    private static byte[] Zip(params (string Name, byte[] Bytes)[] files)
    {
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
            foreach (var (name, bytes) in files)
            {
                using var entry = zip.CreateEntry(name, CompressionLevel.NoCompression).Open();
                entry.Write(bytes);
            }
        return output.ToArray();
    }
}
