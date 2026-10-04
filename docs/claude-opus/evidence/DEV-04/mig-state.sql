SET NOCOUNT ON;
PRINT '== triggers';
SELECT OBJECT_SCHEMA_NAME(t.parent_id) + '.' + OBJECT_NAME(t.parent_id) AS [Table], t.name AS [Trigger], t.is_disabled AS Disabled
FROM sys.triggers t WHERE t.parent_class = 1 ORDER BY 1;
SELECT name AS DatabaseTrigger, is_disabled AS Disabled FROM sys.triggers WHERE parent_class = 0;
PRINT '== roles and members';
SELECT r.name AS [Role], ISNULL(m.name, '-') AS Member FROM sys.database_principals r
LEFT JOIN sys.database_role_members rm ON rm.role_principal_id = r.principal_id
LEFT JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
WHERE r.type = 'R' AND (r.name LIKE 'crm[_]%' OR (r.name IN ('db_datawriter', 'db_datareader', 'db_owner') AND m.name LIKE 'mig[_]%')) ORDER BY 1, 2;
PRINT '== schema grants of crm_runtime';
SELECT SCHEMA_NAME(p.major_id) AS [Schema], STRING_AGG(p.permission_name, ',') WITHIN GROUP (ORDER BY p.permission_name) AS Granted
FROM sys.database_permissions p WHERE p.class = 3 AND p.state = 'G' AND p.grantee_principal_id = DATABASE_PRINCIPAL_ID('crm_runtime')
GROUP BY p.major_id ORDER BY 1;
PRINT '== object denies';
SELECT USER_NAME(p.grantee_principal_id) AS Principal, OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) AS [Object],
       STRING_AGG(p.permission_name, ',') WITHIN GROUP (ORDER BY p.permission_name) AS Denied
FROM sys.database_permissions p WHERE p.class = 1 AND p.state = 'D' AND OBJECT_NAME(p.major_id) <> '__EFMigrationsHistory'
GROUP BY p.grantee_principal_id, p.major_id ORDER BY 1, 2;
SELECT COUNT(*) AS MigrationHistoryDenies FROM sys.database_permissions p WHERE p.class = 1 AND p.state = 'D' AND OBJECT_NAME(p.major_id) = '__EFMigrationsHistory';
PRINT '== object grants';
SELECT USER_NAME(p.grantee_principal_id) AS Principal, OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) AS [Object], p.permission_name
FROM sys.database_permissions p WHERE p.class = 1 AND p.state = 'G' AND USER_NAME(p.grantee_principal_id) LIKE 'crm[_]%' ORDER BY 1, 2;
PRINT '== audit objects';
SELECT name, type_desc FROM sys.objects WHERE SCHEMA_NAME(schema_id) = 'audit' AND type IN ('U', 'P') ORDER BY name;
PRINT '== migrations (audit, billing)';
SELECT 'audit' AS Ctx, MigrationId FROM audit.__EFMigrationsHistory UNION ALL SELECT 'billing', MigrationId FROM billing.__EFMigrationsHistory WHERE MigrationId >= '20261003' ORDER BY 1, 2;
