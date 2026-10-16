using System.Reflection;
using System.Xml.Linq;
using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.ArchitectureTests;

/// <summary>
/// The architecture rules only protect what they can see. These tests fail when a project is added that the rules would
/// silently skip: not built by the solution, not reachable from the deployed hosts, or a module without the expected shape.
/// </summary>
public class CompletenessTests
{
    /// <summary>Reporting composes other modules' contracts and owns no schema; a reporting schema needs an ADR (DEV-14).</summary>
    private static readonly IReadOnlySet<string> ModulesWithoutSchema = new HashSet<string>(StringComparer.Ordinal) { "Crm.Reports" };

    [Fact]
    public void Every_production_project_is_loaded_by_the_rules()
    {
        // Sanity check of the discovery itself: an empty or partial scan would make every rule pass vacuously.
        Production.ModuleNames.ShouldContain("Crm.Billing");
        Production.ModuleNames.ShouldContain("Crm.Projects");
        Production.ModuleNames.ShouldContain("Crm.CustomFields");
        Production.ContractsNames.ShouldContain("Crm.Contracts.Contracts");
        Production.IntegrationNames.ShouldContain("Crm.Integrations.PowerOffice");

        var unreachable = Production.AllProjects
            .Where(project => !Production.NotDeployed.Contains(project) && Production.TryLoad(project) is null)
            .ToList();

        unreachable.ShouldBeEmpty(
            "These projects are not referenced by crm-web or crm-worker, so no architecture rule checks them: " + string.Join(", ", unreachable));
    }

    [Fact]
    public void Every_module_folder_holds_its_implementation_and_at_most_its_contracts()
    {
        Production.ModuleFoldersWithoutImplementation.ShouldBeEmpty();
        Production.UnexpectedModuleProjects.ShouldBeEmpty(
            "The rules know a module's implementation Crm.<Name> and its contracts Crm.<Name>.Contracts only: "
            + string.Join(", ", Production.UnexpectedModuleProjects));
    }

    [Fact]
    public void Every_project_is_part_of_the_solution()
    {
        var solution = XDocument.Load(Path.Combine(Production.Root, "Vardahei.Crm.slnx"));
        var listed = solution.Descendants("Project")
            .Select(p => Normalize(p.Attribute("Path")!.Value))
            .ToHashSet(StringComparer.Ordinal);
        var onDisk = Production.ProjectFiles("src").Concat(Production.ProjectFiles("tests"))
            .Select(path => Normalize(Path.GetRelativePath(Production.Root, path)))
            .ToList();

        var missing = onDisk.Where(path => !listed.Contains(path)).ToList();

        // CI builds and tests the solution; a project outside it is neither compiled nor checked there.
        missing.ShouldBeEmpty("Projects missing from Vardahei.Crm.slnx: " + string.Join(", ", missing));
    }

    [Fact]
    public void Every_module_keeps_its_domain_in_a_domain_namespace_unless_it_is_listed_as_having_none()
    {
        var withDomain = Production.ModuleNames
            .Where(module => Production.Load(module).GetTypes().Any(t => t.Namespace == $"{module}.Domain"))
            .ToHashSet(StringComparer.Ordinal);

        // A module outside the list without a Domain namespace would let the domain rule pass on nothing; a listed module that
        // grows a domain must leave the list so the rule applies to it.
        Production.ModuleNames.Where(m => !withDomain.Contains(m)).Order(StringComparer.Ordinal)
            .ShouldBe(ModuleBoundaryTests.ModulesWithoutDomain.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void Every_module_db_context_declares_its_own_schema()
    {
        var contexts = Production.AllProjects
            .Where(project => !Production.NotDeployed.Contains(project))
            .Select(Production.TryLoad)
            .Where(assembly => assembly is not null)
            .SelectMany(assembly => assembly!.GetTypes())
            .Where(t => t is { IsClass: true, IsAbstract: false } && t.IsSubclassOf(typeof(ModuleDbContext)))
            .ToList();

        // Every module owns a schema except those listed; a new module without one must be listed on purpose.
        var modulesWithContext = contexts.Select(c => c.Assembly.GetName().Name!).ToHashSet(StringComparer.Ordinal);
        Production.ModuleNames.Where(m => !modulesWithContext.Contains(m)).Order(StringComparer.Ordinal)
            .ShouldBe(ModulesWithoutSchema.Order(StringComparer.Ordinal));

        var schemas = new Dictionary<string, Type>(StringComparer.OrdinalIgnoreCase);
        foreach (var context in contexts)
        {
            var declared = context.GetField("SchemaName", BindingFlags.Public | BindingFlags.Static);
            declared.ShouldNotBeNull($"{context.Name} must declare 'public const string SchemaName'.");
            declared.IsLiteral.ShouldBeTrue($"{context.Name}.SchemaName must be a const.");

            var options = (DbContextOptions)Activator.CreateInstance(typeof(DbContextOptions<>).MakeGenericType(context))!;
            using var instance = (ModuleDbContext)Activator.CreateInstance(context, options)!;
            instance.Schema.ShouldBe((string)declared.GetValue(null)!, $"{context.Name} must use its SchemaName.");

            schemas.TryAdd(instance.Schema, context).ShouldBeTrue($"{context.Name} reuses the schema '{instance.Schema}' of {schemas.GetValueOrDefault(instance.Schema)?.Name}.");
        }

        // One context per module assembly (CLAUDE.md: one schema and one ModuleDbContext per module).
        contexts.GroupBy(c => c.Assembly.GetName().Name).Where(g => g.Count() > 1).Select(g => g.Key).ShouldBeEmpty();
    }

    private static string Normalize(string path) => path.Replace('\\', '/');
}
