using System.Reflection;
using NetArchTest.Rules;

namespace Crm.ArchitectureTests;

/// <summary>
/// Enforces the module rules from docs/03-architecture.md §5.2. Modules, contracts and integrations are discovered from src/
/// (<see cref="Production"/>), so every rule covers a new project as soon as it exists.
/// </summary>
public class ModuleBoundaryTests
{
    private static readonly Assembly SharedKernel = typeof(Crm.SharedKernel.Domain.Entity).Assembly;

    /// <summary>Modules that keep no domain model of their own; any other module must have a Domain namespace.</summary>
    internal static readonly IReadOnlySet<string> ModulesWithoutDomain = new HashSet<string>(StringComparer.Ordinal)
    {
        // Audit rows are written by the shared interceptor; the module only holds the context and the audit query.
        "Crm.Audit",
        // Composes other modules' contracts and owns no schema (CLAUDE.md, DEV-14).
        "Crm.Reports",
        // M40.S: registered with their schemas, empty until Huntress (M41) and CloudAlly (M42) bring their domains.
        "Crm.Security",
        "Crm.Backup",
    };

    public static TheoryData<string> ModuleNames => new(Production.ModuleNames);

    public static TheoryData<string> ModulesWithDomain => new(Production.ModuleNames.Where(m => !ModulesWithoutDomain.Contains(m)));

    public static TheoryData<string> ContractsNames => new(Production.ContractsNames);

    public static TheoryData<string> IntegrationNames => new(Production.IntegrationNames);

    [Theory]
    [MemberData(nameof(ModuleNames))]
    public void Modules_do_not_reference_other_module_implementations(string moduleName)
    {
        var others = Production.ModuleNames
            .Where(name => name != moduleName)
            .SelectMany(ImplementationTypes)
            .ToArray();

        var result = Types.InAssembly(Production.Load(moduleName)).ShouldNot().HaveDependencyOnAny(others).GetResult();

        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [MemberData(nameof(ModuleNames))]
    public void Core_modules_do_not_know_about_integrations(string moduleName)
    {
        var result = Types.InAssembly(Production.Load(moduleName)).ShouldNot().HaveDependencyOn("Crm.Integrations").GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [MemberData(nameof(IntegrationNames))]
    public void Integrations_use_only_module_contracts(string integration)
    {
        var implementations = Production.ModuleNames.SelectMany(ImplementationTypes).ToArray();
        var result = Types.InAssembly(Production.Load(integration)).ShouldNot().HaveDependencyOnAny(implementations).GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Fact]
    public void Shared_kernel_is_framework_free()
    {
        var result = Types.InAssembly(SharedKernel)
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Crm.Infrastructure")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [MemberData(nameof(ContractsNames))]
    public void Contracts_do_not_depend_on_infrastructure(string contracts)
    {
        var result = Types.InAssembly(Production.Load(contracts))
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Crm.Infrastructure")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [MemberData(nameof(ModulesWithDomain))]
    public void Domain_types_do_not_depend_on_persistence(string moduleName)
    {
        var result = Types.InAssembly(Production.Load(moduleName))
            .That().ResideInNamespace($"{moduleName}.Domain")
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", $"{moduleName}.Persistence")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    // NetArchTest matches by name prefix and "Crm.Customers" also prefixes "Crm.Customers.Contracts",
    // so implementation types are listed by full name instead of by namespace.
    private static IEnumerable<string> ImplementationTypes(string moduleName) =>
        Production.Load(moduleName).GetTypes()
            .Where(t => t.FullName is not null && !t.FullName.Contains('<', StringComparison.Ordinal) && t.DeclaringType is null)
            .Select(t => t.FullName!)
            .Distinct();

    private static string Describe(NetArchTest.Rules.TestResult result) =>
        result.IsSuccessful ? string.Empty : "Violations: " + string.Join(", ", result.FailingTypeNames ?? []);
}
