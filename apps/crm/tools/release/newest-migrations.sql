-- The newest applied migration of every module schema (tools/release/rollback-compat.sh).
SET NOCOUNT ON;
DECLARE @query nvarchar(max) = (
    SELECT STRING_AGG(CONVERT(nvarchar(max),
               CONCAT(N'SELECT N', QUOTENAME(OBJECT_SCHEMA_NAME(object_id), ''''), N' AS [Schema], MAX(MigrationId) AS Newest FROM ',
                      QUOTENAME(OBJECT_SCHEMA_NAME(object_id)), N'.[__EFMigrationsHistory]')), N' UNION ALL ')
    FROM sys.tables WHERE name = N'__EFMigrationsHistory');
SET @query = @query + N' ORDER BY [Schema];';
EXEC sp_executesql @query;
