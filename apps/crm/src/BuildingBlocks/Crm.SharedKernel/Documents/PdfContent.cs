namespace Crm.SharedKernel.Documents;

/// <summary>Bounded PDF envelope checks; not a PDF interpreter, malware scanner or proof of source authenticity.</summary>
public static class PdfContent
{
    public const int MaxLength = 30 * 1024 * 1024;

    public static void Validate(ReadOnlySpan<byte> content)
    {
        if (content.Length is < 20 or > MaxLength || !content[..5].SequenceEqual("%PDF-"u8) ||
            !(content[5] is (byte)'1' or (byte)'2') || content[6] != '.' || content[7] < '0' || content[7] > '9')
            throw new InvalidDataException("Invalid or oversized PDF envelope.");
        var end = content.Length;
        while (end > 0 && content[end - 1] is 0 or 9 or 10 or 12 or 13 or 32) end--;
        if (end < 5 || !content.Slice(end - 5, 5).SequenceEqual("%%EOF"u8))
            throw new InvalidDataException("Truncated PDF envelope.");
    }

    public static void ValidateSourceName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 240 || name.StartsWith('/') ||
            name.Any(c => char.IsControl(c) || c is '\\' or ':') ||
            name.Split('/').Any(s => s is "" or "." or "..") || !name.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Invalid source PDF name.");
    }
}
