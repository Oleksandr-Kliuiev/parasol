using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.Billing.Contracts;
using Crm.SharedKernel.Domain;

namespace Crm.Billing.Domain;

/// <summary>Source operations remain separate from inferred InvoicePayment balance observations.</summary>
public sealed class CustomerLedgerEntry : Entity
{
    private readonly List<CustomerLedgerVersion> _versions = [];
    private CustomerLedgerEntry() { }
    public string System { get; private set; } = string.Empty;
    public long ExternalId { get; private set; }
    public string CustomerKey { get; private set; } = string.Empty;
    public Guid VoucherId { get; private set; }
    public long? MatchId { get; private set; }
    public CustomerLedgerKind Kind { get; private set; }
    public DateOnly PostingDate { get; private set; }
    public DateTimeOffset LastChangedAt { get; private set; }
    public Guid LastSeenScanId { get; private set; }
    public DateTimeOffset LastSeenAt { get; private set; }
    public string SnapshotJson { get; private set; } = string.Empty;
    public ExternalCustomerLedgerEntry Source => CustomerLedgerJson.Read(SnapshotJson);
    public IReadOnlyList<CustomerLedgerVersion> Versions => _versions;

    public static CustomerLedgerEntry From(string system, ExternalCustomerLedgerEntry source, Guid scanId, DateTimeOffset observedAt)
    {
        var entry = new CustomerLedgerEntry { System = system, ExternalId = source.ExternalId, CustomerKey = source.ExternalCustomerId ?? "" };
        entry.Apply(source, scanId, observedAt);
        return entry;
    }

    public bool Apply(ExternalCustomerLedgerEntry source, Guid scanId, DateTimeOffset observedAt)
    {
        if (source.ExternalId != ExternalId || CustomerKey.Length > 0 && (source.ExternalCustomerId ?? "") != CustomerKey)
            throw new InvalidOperationException("A ledger source identity cannot change.");
        if (SnapshotJson.Length > 0)
        {
            var previous = Source;
            if (source.LastChangedAt < LastChangedAt)
                throw new InvalidOperationException("A stale ledger version cannot become the current scan.");
            if (source.VoucherId != VoucherId || source.VoucherNo != previous.VoucherNo || source.Amount != previous.Amount ||
                source.CurrencyAmount != previous.CurrencyAmount || source.CurrencyCode != previous.CurrencyCode ||
                source.PostingDate != PostingDate || source.VoucherDate != previous.VoucherDate || source.CreatedAt != previous.CreatedAt)
                throw new InvalidOperationException("A posted ledger transaction cannot change.");
            if (source.LastChangedAt == LastChangedAt && (source.MatchId != MatchId || source.Balance != previous.Balance))
                throw new InvalidOperationException("Conflicting ledger match states have the same source version.");
        }
        var json = CustomerLedgerJson.Write(source);
        var changed = SnapshotJson != json;
        if (changed) _versions.Add(CustomerLedgerVersion.Create(Id, source.LastChangedAt, observedAt, json));
        SnapshotJson = json;
        CustomerKey = source.ExternalCustomerId ?? "";
        VoucherId = source.VoucherId;
        Kind = source.Kind;
        PostingDate = source.PostingDate;
        MatchId = source.MatchId;
        LastChangedAt = source.LastChangedAt;
        LastSeenScanId = scanId;
        LastSeenAt = observedAt;
        return changed;
    }
}

public sealed class CustomerLedgerVersion : Entity
{
    private CustomerLedgerVersion() { }
    public Guid EntryId { get; private set; }
    public DateTimeOffset SourceChangedAt { get; private set; }
    public DateTimeOffset ObservedAt { get; private set; }
    public string SnapshotJson { get; private set; } = string.Empty;
    internal static CustomerLedgerVersion Create(Guid id, DateTimeOffset sourceChanged, DateTimeOffset observed, string json) =>
        new() { EntryId = id, SourceChangedAt = sourceChanged, ObservedAt = observed, SnapshotJson = json };
}

internal static class CustomerLedgerJson
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
    public static ExternalCustomerLedgerEntry Read(string json) => JsonSerializer.Deserialize<ExternalCustomerLedgerEntry>(json, Options)!;
    public static string Write(ExternalCustomerLedgerEntry entry)
    {
        if (entry.ExternalId <= 0 || entry.VoucherId == Guid.Empty) throw new InvalidOperationException("Invalid ledger identity.");
        var json = JsonSerializer.Serialize(entry, Options);
        if (Encoding.UTF8.GetByteCount(json) > 256 * 1024) throw new InvalidOperationException("Ledger entry exceeds the storage limit.");
        return json;
    }
}

/// <summary>A complete source scan for one source customer, including an explicitly empty scan; no source row is deleted.</summary>
public sealed class CustomerLedgerSnapshot
{
    public string System { get; set; } = string.Empty;
    public string CustomerKey { get; set; } = string.Empty;
    public Guid? OrganizationId { get; set; }
    public Guid ScanId { get; set; }
    public DateTimeOffset ReadStartedAt { get; set; }
    public DateTimeOffset SavedAt { get; set; }
}
