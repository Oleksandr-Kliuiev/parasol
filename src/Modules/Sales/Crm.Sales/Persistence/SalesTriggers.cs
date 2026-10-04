namespace Crm.Sales.Persistence;

/// <summary>Triggers of the sales schema; their SQL lives verbatim in the migration that creates them (DEV-08).</summary>
public static class SalesTriggers
{
    /// <summary>
    /// Migration QuoteDocuments: a quote document is never deleted, a Ready document never changes, and a Preparing one
    /// changes only by becoming Ready with the hash and length of what was stored — for every identity, a database
    /// administrator's included (the trigger has to be dropped deliberately first).
    /// </summary>
    public const string QuoteDocuments = "trg_QuoteDocuments_Protect";
}
