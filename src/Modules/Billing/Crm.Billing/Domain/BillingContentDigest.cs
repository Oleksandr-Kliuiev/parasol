using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Crm.Billing.Contracts;

namespace Crm.Billing.Domain;

/// <summary>
/// A fingerprint of what a run would invoice: every basis that is not deleted (payer, and whether it was cancelled) and every
/// billed line (source, customer, product, quantity, price, discount, VAT, total and text). Decimals are written as
/// <c>0.####</c> with the invariant culture and everything is sorted, so the same content always gives the same digest
/// (ADR-012). The delivery status of a basis (approved, exported, failed) is not content: the digest of a released run can be
/// computed again later and still matches. It is a check on content, not a replacement for authorization or the transaction.
/// </summary>
public static class BillingContentDigest
{
    public static string Compute(IEnumerable<BillingBasis> bases)
    {
        var canonical = bases
            .Where(b => !b.IsDeleted)
            .OrderBy(b => b.OrganizationId)
            .Select(b => new CanonicalBasis(
                b.OrganizationId.ToString("N"),
                // A basis with nothing but information lines is cancelled by its approval; only cancelling an invoice is content.
                b.Status == BillingBasisStatus.Cancelled && b.BilledLines.Any(l => l.Group != BillingGroup.Info),
                b.BilledLines
                    .OrderBy(l => l.SourceKey ?? string.Empty, StringComparer.Ordinal)
                    .ThenBy(l => l.Id)
                    .Select(l => new CanonicalLine(
                        l.SourceKey ?? $"manual:{l.Id:N}",
                        l.SourceOrganizationId?.ToString("N") ?? "-",
                        l.Group.ToString(),
                        l.ProductId?.ToString("N") ?? "-",
                        Number(l.Quantity),
                        Number(l.UnitPrice),
                        Number(l.DiscountPct),
                        Number(l.VatRate),
                        Number(l.LineTotal),
                        l.Description))
                    .ToList()))
            .ToList();
        var json = JsonSerializer.SerializeToUtf8Bytes(canonical);
        return Convert.ToHexStringLower(SHA256.HashData(json));
    }

    private static string Number(decimal value) => value.ToString("0.####", CultureInfo.InvariantCulture);

    private sealed record CanonicalBasis(string Payer, bool Cancelled, IReadOnlyList<CanonicalLine> Lines);

    private sealed record CanonicalLine(
        string Source, string Customer, string Group, string Product, string Quantity, string UnitPrice, string DiscountPct, string VatRate, string Total,
        string Text);
}
