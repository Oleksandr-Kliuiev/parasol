using System.IO.Compression;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Documents;

namespace Crm.Integrations.PowerOffice;

/// <summary>Never extracts names onto disk. CRC checks the ZIP transport; SHA-256 later binds persisted PDF bytes.</summary>
public static class PowerOfficePdfArchive
{
    public const int MaxArchiveLength = 60 * 1024 * 1024;
    public const long MaxExpandedLength = 100L * 1024 * 1024;

    public static async Task<IReadOnlyList<ExternalInvoicePdf>> ReadAsync(byte[] archive, CancellationToken ct)
    {
        if (archive.Length is < 22 or > MaxArchiveLength || !archive.AsSpan(0, 4).SequenceEqual("PK\x03\x04"u8))
            throw new InvalidDataException("Invalid PDF ZIP archive.");
        using var input = new MemoryStream(archive, writable: false);
        using var zip = new ZipArchive(input, ZipArchiveMode.Read);
        if (zip.Entries.Count is < 1 or > 20) throw new InvalidDataException("Invalid PDF archive entry count.");
        var names = new HashSet<string>(StringComparer.Ordinal);
        var files = new List<ExternalInvoicePdf>();
        long total = 0;
        foreach (var entry in zip.Entries)
        {
            ct.ThrowIfCancellationRequested();
            PdfContent.ValidateSourceName(entry.FullName);
            if (!names.Add(entry.FullName) || entry.Length is < 20 or > PdfContent.MaxLength ||
                (total += entry.Length) > MaxExpandedLength || entry.IsEncrypted)
                throw new InvalidDataException("Invalid PDF archive member.");
            await using var source = entry.Open();
            using var output = new MemoryStream();
            var chunk = new byte[81920];
            int count;
            while ((count = await source.ReadAsync(chunk, ct)) > 0)
            {
                if (output.Length + count > entry.Length) throw new InvalidDataException("Expanded PDF exceeds its declared length.");
                output.Write(chunk, 0, count);
            }
            var content = output.ToArray();
            if (content.LongLength != entry.Length || Crc32(content) != entry.Crc32)
                throw new InvalidDataException("PDF archive member failed CRC/length verification.");
            PdfContent.Validate(content);
            files.Add(new(entry.FullName, content));
        }
        return files;
    }

    private static uint Crc32(ReadOnlySpan<byte> content)
    {
        uint crc = uint.MaxValue;
        foreach (var b in content)
        {
            crc ^= b;
            for (int bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xedb88320u : 0u);
        }
        return ~crc;
    }
}
