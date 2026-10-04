SET NOCOUNT ON;
-- Synthetic audit entries of the previous version (no real data): personal fields filled.
INSERT INTO audit.AuditEntries ([At], [UserId], [UserName], [Action], [Module], [EntityType], [EntityId], [Changes], [CorrelationId], [IpAddress]) VALUES
 ('2024-02-01T10:00:00+00:00', '0b000000-0000-0000-0000-000000000001', N'Test Person A', N'Update', N'customers', N'Contact', '0c000000-0000-0000-0000-000000000001', N'{"email":"a@example.invalid"}', N'mig-dev04', N'192.0.2.10'),
 ('2024-03-01T10:00:00+00:00', '0b000000-0000-0000-0000-000000000002', N'Test Person B', N'Update', N'billing', N'BillingBasis', '20000000-0000-0000-0000-000000000003', N'{"totalExVat":0}', N'mig-dev04', N'192.0.2.11'),
 ('2026-09-01T10:00:00+00:00', '0b000000-0000-0000-0000-000000000001', N'Test Person A', N'Create', N'customers', N'Organization', '0c000000-0000-0000-0000-000000000002', N'{"name":"Example AS"}', N'mig-dev04', N'192.0.2.10');
