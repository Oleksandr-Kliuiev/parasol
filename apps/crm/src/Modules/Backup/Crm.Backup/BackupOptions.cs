namespace Crm.Backup;

/// <summary>Settings of the backup module (M42).</summary>
public sealed class BackupOptions
{
    public const string SectionName = "Backup";

    /// <summary>
    /// The data center the customers' backups belong in (M42: EU). CloudAlly has one API host for every region; the region is each
    /// account's own (<c>EU</c>, <c>EU_FRANKFURT</c>, <c>EU_STOCKHOLM</c>, …, <c>LONDON</c>). An account whose region does not start with
    /// this one is still read, and the tab marks it.
    /// </summary>
    public string Region { get; set; } = "EU";

    /// <summary>Whether a region the source reported lies outside <see cref="Region"/>; an unknown region is not marked.</summary>
    public bool IsOutside(string? region) =>
        !string.IsNullOrWhiteSpace(region) && !string.IsNullOrWhiteSpace(Region) && !region.StartsWith(Region.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// The Microsoft SKUs whose users have a mailbox of their own, by part number or its start (so <c>SPE_E3</c> also counts a
    /// <c>SPE_E3_…</c> variant): the licensed users the check compares with the mailboxes in backup. Add-ons (archiving, extra
    /// storage) and plans without a mailbox are left out; a customer's SKUs outside this list are not counted.
    /// </summary>
    public List<string> MailboxSkus { get; set; } =
    [
        "O365_BUSINESS_ESSENTIALS", "O365_BUSINESS_PREMIUM", "SPB", "SMB_BUSINESS_ESSENTIALS", "SMB_BUSINESS_PREMIUM",
        "STANDARDPACK", "ENTERPRISEPACK", "ENTERPRISEPREMIUM", "SPE_E3", "SPE_E5", "SPE_F1", "DESKLESSPACK",
        "EXCHANGESTANDARD", "EXCHANGEENTERPRISE", "EXCHANGEDESKLESS", "EXCHANGE_S_ESSENTIALS",
    ];

    /// <summary>Whether a SKU part number gives its users a mailbox, by <see cref="MailboxSkus"/>.</summary>
    public bool GivesMailbox(string skuPartNumber) =>
        MailboxSkus.Any(sku => !string.IsNullOrWhiteSpace(sku) && skuPartNumber.StartsWith(sku.Trim(), StringComparison.OrdinalIgnoreCase));
}
