using System.Reflection;

namespace Crm.ArchitectureTests;

/// <summary>
/// The production projects as the source tree has them, so the rules cover a new module, contracts project or integration
/// without anyone editing a list. The assemblies come from crm-web and crm-worker, which this test project references;
/// <see cref="CompletenessTests"/> fails when a project under src/ is not among them.
/// </summary>
internal static class Production
{
    public static string Root { get; } = FindRoot();

    /// <summary>Hosts that are not deployed (the local Aspire orchestrator) and need not be loadable here.</summary>
    public static readonly IReadOnlySet<string> NotDeployed = new HashSet<string>(StringComparer.Ordinal) { "Crm.AppHost" };

    /// <summary>Every project under src/, by folder.</summary>
    public static IReadOnlyList<string> AllProjects { get; } =
        new[] { "BuildingBlocks", "Hosts", "Integrations", "Modules" }.SelectMany(ProjectsIn).Order(StringComparer.Ordinal).ToList();

    /// <summary>
    /// A module is a folder src/Modules/&lt;Name&gt; holding Crm.&lt;Name&gt; and, when others may call it, Crm.&lt;Name&gt;.Contracts
    /// (so the Contracts module is Crm.Contracts with Crm.Contracts.Contracts).
    /// </summary>
    private static readonly IReadOnlyList<(string Folder, IReadOnlyList<string> Projects)> Modules =
        Directory.EnumerateDirectories(Path.Combine(Root, "src", "Modules"))
            .Select(folder => (Path.GetFileName(folder), (IReadOnlyList<string>)ProjectsIn(Path.Combine("Modules", Path.GetFileName(folder))).ToList()))
            .OrderBy(m => m.Item1, StringComparer.Ordinal)
            .ToList();

    /// <summary>Module implementations, e.g. Crm.Billing.</summary>
    public static IReadOnlyList<string> ModuleNames { get; } =
        Modules.Where(m => m.Projects.Contains($"Crm.{m.Folder}")).Select(m => $"Crm.{m.Folder}").ToList();

    /// <summary>Public contracts of modules, e.g. Crm.Billing.Contracts.</summary>
    public static IReadOnlyList<string> ContractsNames { get; } =
        Modules.Where(m => m.Projects.Contains($"Crm.{m.Folder}.Contracts")).Select(m => $"Crm.{m.Folder}.Contracts").ToList();

    /// <summary>Projects in a module folder that are neither its implementation nor its contracts; the rules do not know them.</summary>
    public static IReadOnlyList<string> UnexpectedModuleProjects { get; } =
        Modules.SelectMany(m => m.Projects.Where(p => p != $"Crm.{m.Folder}" && p != $"Crm.{m.Folder}.Contracts")).ToList();

    /// <summary>Module folders without an implementation project, e.g. a contracts project left behind.</summary>
    public static IReadOnlyList<string> ModuleFoldersWithoutImplementation { get; } =
        Modules.Where(m => !m.Projects.Contains($"Crm.{m.Folder}")).Select(m => m.Folder).ToList();

    public static IReadOnlyList<string> IntegrationNames { get; } = ProjectsIn("Integrations").Order(StringComparer.Ordinal).ToList();

    public static Assembly Load(string projectName) => Assembly.Load(new AssemblyName(projectName));

    public static Assembly? TryLoad(string projectName)
    {
        try
        {
            return Load(projectName);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
    }

    /// <summary>Project files below a folder of the repository, skipping build output.</summary>
    public static IEnumerable<string> ProjectFiles(string folder) =>
        Directory.EnumerateFiles(Path.Combine(Root, folder), "*.csproj", SearchOption.AllDirectories)
            .Where(path => !path.Split(Path.DirectorySeparatorChar).Any(part => part is "bin" or "obj"));

    private static IEnumerable<string> ProjectsIn(string folderUnderSrc) =>
        ProjectFiles(Path.Combine("src", folderUnderSrc)).Select(path => Path.GetFileNameWithoutExtension(path)!);

    private static string FindRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Vardahei.Crm.slnx")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException($"No Vardahei.Crm.slnx above {AppContext.BaseDirectory}.");
    }
}
