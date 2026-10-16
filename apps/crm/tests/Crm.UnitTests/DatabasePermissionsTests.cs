using Crm.Billing.Persistence;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.UnitTests;

/// <summary>The permission script the migrator applies and the EF Core mapping of the protected tables (DEV-04).</summary>
public class DatabasePermissionsTests
{
    [Fact]
    public void The_runtime_role_gets_data_access_per_schema_audit_only_by_insert_and_never_a_fixed_role()
    {
        var script = DatabasePermissions.Script(["audit", "billing", "customers"], [new BillingDatabasePermissions()]);

        script.ShouldContain("GRANT SELECT, INSERT ON SCHEMA::[audit] TO [crm_runtime];");
        script.ShouldNotContain("GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[audit]");
        script.ShouldContain("GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::[billing] TO [crm_runtime];");
        script.ShouldContain("DENY UPDATE, DELETE ON OBJECT::[audit].[AuditEntries] TO [crm_runtime];");
        script.ShouldContain("DENY INSERT, UPDATE, DELETE ON OBJECT::[customers].[__EFMigrationsHistory] TO [crm_runtime];");
        script.ShouldContain("DENY UPDATE, DELETE ON OBJECT::[billing].[OutboxMessages] TO [crm_web];");
        script.ShouldContain("DENY DELETE ON OBJECT::[billing].[BillingLines] TO [crm_runtime];");
        script.ShouldContain("DENY UPDATE ON OBJECT::[billing].[BillingExportAttempts] TO [crm_runtime];");
        script.ShouldContain("ALTER ROLE [crm_runtime] ADD MEMBER [crm_web];");
        script.ShouldContain("ALTER ROLE [crm_runtime] ADD MEMBER [crm_worker];");
        script.ShouldNotContain("db_datawriter");
        script.ShouldNotContain("db_owner");
    }

    [Fact]
    public void An_identity_is_made_a_member_of_exactly_its_role_and_loses_the_broad_ones()
    {
        var script = DatabasePermissions.MembershipScript("id-crm-app-test", DatabaseRoles.Web);

        script.ShouldContain("ALTER ROLE [crm_web] ADD MEMBER [id-crm-app-test];");
        foreach (var other in DatabaseRoles.All.Where(r => r != DatabaseRoles.Web).Concat(DatabasePermissions.BroadRoles))
        {
            script.ShouldContain($"ALTER ROLE [{other}] DROP MEMBER [id-crm-app-test];");
        }

        script.ShouldNotContain("ALTER ROLE [crm_worker] ADD MEMBER");
    }

    [Fact]
    public void The_rollback_guard_refuses_every_broad_role_for_every_application_role()
    {
        var trigger = DatabasePermissions.NarrowRolesTriggerScript();

        trigger.ShouldContain("ON DATABASE FOR ADD_ROLE_MEMBER");
        foreach (var role in DatabasePermissions.BroadRoles.Concat(DatabaseRoles.All))
        {
            trigger.ShouldContain($"N'{role}'");
        }
    }

    [Theory]
    [InlineData("billing]; DROP TABLE x; --")]
    [InlineData("bil ling")]
    [InlineData("")]
    public void Names_that_could_break_out_of_the_script_are_refused(string name)
    {
        Should.Throw<InvalidOperationException>(() => DatabasePermissions.Script([name], []));
        Should.Throw<InvalidOperationException>(() => DatabasePermissions.MembershipScript(name, DatabaseRoles.Worker));
    }

    [Fact]
    public void Every_protected_billing_table_tells_entity_framework_about_its_trigger()
    {
        // Without HasTrigger, EF Core saves with OUTPUT without INTO, which SQL Server refuses on a table with a trigger.
        using var db = new BillingDbContext(new DbContextOptionsBuilder<BillingDbContext>().UseSqlServer("Server=unused").Options);
        var declared = db.Model.GetEntityTypes()
            .SelectMany(e => e.GetDeclaredTriggers().Select(t => (Table: e.GetTableName(), Trigger: t.GetDatabaseName())))
            .ToList();

        declared.Select(d => d.Trigger).Order(StringComparer.Ordinal).ShouldBe(BillingTriggers.All.Order(StringComparer.Ordinal));
        foreach (var (table, trigger) in declared)
        {
            var sql = typeof(BillingTriggers).GetFields()
                .Where(f => f.Name.StartsWith("Create", StringComparison.Ordinal))
                .Select(f => (string)f.GetValue(null)!)
                .Single(s => s.Contains($"[billing].[{trigger}]", StringComparison.Ordinal));
            sql.ShouldContain($"ON [billing].[{table}]");
        }
    }
}
