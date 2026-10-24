using System.Reflection;
using Crm.Infrastructure.Persistence;

namespace Crm.ArchitectureTests;

/// <summary>
/// M40.S: the security and backup modules stand before their integrations (Huntress in M41, CloudAlly in M42) bring their data.
/// Each is a module of the usual shape with a schema of its own, registered by both hosts, and nothing else reaches into its
/// implementation: since M41 the Huntress integration writes the security module through <c>Crm.Security.Contracts</c>, as the module
/// rules require.
/// </summary>
public class CoverageModulesTests
{
    public static TheoryData<string, string, string> Modules => new()
    {
        { "Crm.Security", "Crm.Security.Persistence.SecurityDbContext", "security" },
        { "Crm.Backup", "Crm.Backup.Persistence.BackupDbContext", "backup" },
    };

    [Theory]
    [MemberData(nameof(Modules))]
    public void The_module_stands_with_its_own_schema(string module, string context, string schema)
    {
        Production.ModuleNames.ShouldContain(module);
        var type = Production.Load(module).GetType(context, throwOnError: true)!;
        type.IsSubclassOf(typeof(ModuleDbContext)).ShouldBeTrue();
        type.GetField("SchemaName", BindingFlags.Public | BindingFlags.Static)!.GetRawConstantValue().ShouldBe(schema);
    }

    [Theory]
    [MemberData(nameof(Modules))]
    public void Only_the_hosts_reference_the_module(string module, string context, string schema)
    {
        _ = (context, schema);
        var referencing = Production.AllProjects
            .Where(project => !Production.NotDeployed.Contains(project) && project != module)
            .Select(Production.TryLoad)
            .Where(assembly => assembly is not null && assembly.GetReferencedAssemblies().Any(r => r.Name == module))
            .Select(assembly => assembly!.GetName().Name!)
            .Order(StringComparer.Ordinal)
            .ToList();

        referencing.ShouldBe(["Crm.Web", "Crm.Worker"]);
    }
}
