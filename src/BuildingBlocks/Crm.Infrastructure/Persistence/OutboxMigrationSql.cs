namespace Crm.Infrastructure.Persistence;

/// <summary>Data steps of the DEV-07 outbox migration, shared by every module context.</summary>
public static class OutboxMigrationSql
{
    /// <summary>
    /// Gives the rows written before DEV-07 an explicit state. The new column starts as Pending; delivered rows become
    /// Processed, and rows that had used up their ten attempts become dead letters — visible and replayable by a person,
    /// never retried automatically (task card DEV-07, «Данные и обратимость»).
    /// </summary>
    public static string Backfill(string schema)
    {
        DatabasePermissions.Guard(schema);
        // Only rows still in the column's default state: running it again changes nothing that DEV-07 code decided.
        return $"""
            UPDATE [{schema}].[OutboxMessages] SET [Status] = N'Processed'
            WHERE [Status] = N'Pending' AND [ProcessedAt] IS NOT NULL;
            UPDATE [{schema}].[OutboxMessages] SET [Status] = N'DeadLetter', [DeadLetteredAt] = SYSDATETIMEOFFSET(), [LockedUntil] = NULL
            WHERE [Status] = N'Pending' AND [ProcessedAt] IS NULL AND [Attempts] >= {OutboxMessage.MaxAttempts};
            """;
    }
}
