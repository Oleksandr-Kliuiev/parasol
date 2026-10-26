using System.Text;
using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using Crm.SharedKernel.Documents;

namespace Crm.UnitTests;

/// <summary>
/// A document the CRM files for a customer (M43) names its bytes by their hash under the customer's folder, keeps the period and source
/// it came from, and is refused when it is not a whole PDF, has an unknown kind, or a source key or file name that could not be stored.
/// </summary>
public sealed class StoredDocumentTests
{
    private static readonly byte[] Pdf = Encoding.Latin1.GetBytes("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n");
    private static readonly Guid Organization = Guid.Parse("22222222-2222-2222-2222-222222222222");

    private static StoredDocumentFiling Filing(
        string kind = StoredDocumentKinds.HuntressMonthly, string? source = null, string file = "huntress-2026-09-9001.pdf", byte[]? content = null) =>
        new(Organization, kind, source ?? StoredDocumentKinds.HuntressReport(9001), new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30), file, content ?? Pdf,
            StoredDocumentProvenance.Source);

    [Fact]
    public void A_document_is_named_by_its_hash_under_the_customer()
    {
        var at = new DateTimeOffset(2026, 10, 1, 3, 55, 0, TimeSpan.Zero);
        var document = StoredDocument.Create(Filing(), at);
        var hash = DocumentHashes.Sha256(Pdf);
        (document.ObjectKey, document.ContentSha256, document.Length, document.SourceKey, document.StoredAt, document.MediaType).ShouldBe(
            ($"customers/documents/{Organization:N}/{hash}.pdf", hash, (long)Pdf.Length, "huntress:report:9001", at, "application/pdf"));
        StoredDocumentKinds.ParasollSummary(new DateOnly(2026, 9, 1)).ShouldBe("parasoll:summary:2026-09");
    }

    [Fact]
    public void What_cannot_be_stored_whole_is_refused()
    {
        Should.Throw<InvalidOperationException>(() => StoredDocument.Create(Filing(kind: "invoice"), DateTimeOffset.UtcNow));
        Should.Throw<InvalidOperationException>(() => StoredDocument.Create(Filing(source: new string('k', StoredDocument.SourceKeyLength + 1)), DateTimeOffset.UtcNow));
        Should.Throw<InvalidOperationException>(() => StoredDocument.Create(Filing(source: "huntress:report:\n1"), DateTimeOffset.UtcNow));
        Should.Throw<InvalidDataException>(() => StoredDocument.Create(Filing(file: "../escape.pdf"), DateTimeOffset.UtcNow));
        Should.Throw<InvalidDataException>(() => StoredDocument.Create(Filing(file: "report.html"), DateTimeOffset.UtcNow));
        Should.Throw<InvalidDataException>(() => StoredDocument.Create(Filing(content: Encoding.UTF8.GetBytes("<html>Sign in</html>")), DateTimeOffset.UtcNow));
    }
}
