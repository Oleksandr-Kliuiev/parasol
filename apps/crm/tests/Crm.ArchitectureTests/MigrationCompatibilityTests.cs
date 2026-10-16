using System.Text.RegularExpressions;

namespace Crm.ArchitectureTests;

/// <summary>
/// Schema changes are expand-only (DEV-05-AC04): the previous release must keep working on the new schema, because the
/// migrations run before the new revision gets traffic and a rollback runs no migrations at all. A contract step (drop,
/// rename, narrowing, a required column without a default) needs its own release after nothing uses the old shape any
/// more, an ADR and an entry in <see cref="ApprovedContractSteps"/>.
/// </summary>
public partial class MigrationCompatibilityTests
{
    /// <summary>Contract steps that were planned and released on their own: migration file name → reason (ADR).</summary>
    private static readonly Dictionary<string, string> ApprovedContractSteps = new(StringComparer.Ordinal);

    private static readonly string[] Destructive =
        ["DropTable", "DropColumn", "RenameColumn", "RenameTable", "DropSchema", "DropSequence", "DeleteData", "RenameIndex"];

    private static IEnumerable<(string File, string Up)> Migrations() => MigrationsByContext().Select(m => (m.File, m.Up));

    /// <summary>Migrations with their context: the project that owns the Persistence/Migrations folder, e.g. Crm.Billing.</summary>
    private static IEnumerable<(string Context, string File, string Up)> MigrationsByContext() =>
        Directory.EnumerateFiles(Path.Combine(Production.Root, "src"), "*.cs", SearchOption.AllDirectories)
            .Where(f => f.Contains($"{Path.DirectorySeparatorChar}Persistence{Path.DirectorySeparatorChar}Migrations{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                        && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(f => MigrationFile().IsMatch(Path.GetFileName(f)))
            .Select(f =>
            {
                var text = File.ReadAllText(f);
                var up = text.IndexOf("void Up(", StringComparison.Ordinal);
                var down = text.IndexOf("void Down(", StringComparison.Ordinal);
                var context = Path.GetFileName(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(f))))!;
                return (context, Path.GetFileName(f), up < 0 ? string.Empty : text[up..(down < 0 ? text.Length : down)]);
            });

    [GeneratedRegex(@"^\d{14}_\w+\.cs$")]
    private static partial Regex MigrationFile();

    [GeneratedRegex(@"migrationBuilder\.(AddColumn|AlterColumn)<[^>]+>\((.*?)\);", RegexOptions.Singleline)]
    private static partial Regex ColumnCall();

    [Fact]
    public void The_rule_sees_the_migrations()
    {
        Migrations().Count().ShouldBeGreaterThan(30);
        Migrations().ShouldContain(m => m.File == "20261004002311_ChargeRegister.cs");
    }

    [Fact]
    public void Migrations_only_expand_the_schema_unless_a_contract_step_is_approved()
    {
        var violations = new List<string>();
        foreach (var (file, up) in Migrations().Where(m => !ApprovedContractSteps.ContainsKey(m.File)))
        {
            foreach (var operation in Destructive.Where(op => up.Contains($"migrationBuilder.{op}(", StringComparison.Ordinal)))
            {
                violations.Add($"{file}: {operation}");
            }

            foreach (Match call in ColumnCall().Matches(up))
            {
                var kind = call.Groups[1].Value;
                var args = call.Groups[2].Value;
                var name = Regex.Match(args, "name: \"([^\"]+)\"").Groups[1].Value;
                var required = Regex.IsMatch(args, @"(?<!old)nullable:\s*false");
                if (kind == "AddColumn" && required && !Regex.IsMatch(args, @"defaultValue(Sql)?:|computedColumnSql:"))
                {
                    violations.Add($"{file}: required column {name} without a default (the previous release cannot insert)");
                }

                if (kind == "AlterColumn")
                {
                    var maxLength = Regex.Match(args, @"(?<!old)maxLength:\s*(\d+)");
                    var oldMaxLength = Regex.Match(args, @"oldMaxLength:\s*(\d+)");
                    if (maxLength.Success && oldMaxLength.Success && int.Parse(maxLength.Groups[1].Value) < int.Parse(oldMaxLength.Groups[1].Value))
                    {
                        violations.Add($"{file}: {name} narrowed");
                    }

                    if (required && Regex.IsMatch(args, @"oldNullable:\s*true"))
                    {
                        violations.Add($"{file}: {name} made required");
                    }

                    var type = Regex.Match(args, "(?<!old)[tT]ype: \"([a-z]+)").Groups[1].Value;
                    var oldType = Regex.Match(args, "oldType: \"([a-z]+)").Groups[1].Value;
                    if (type.Length > 0 && oldType.Length > 0 && type != oldType)
                    {
                        violations.Add($"{file}: {name} changes type {oldType} → {type}");
                    }
                }
            }
        }

        violations.ShouldBeEmpty("Expand/contract (docs/adr/ADR-015-release-pipeline.md): " + string.Join("; ", violations));
    }

    /// <summary>
    /// A trigger can make the previous release fail on the new schema even though no column changed (DEV-04: EF Core without
    /// HasTrigger writes with OUTPUT, which SQL Server refuses). Every migration that creates one is therefore registered in
    /// tools/release/schema-breaks.json — as a break, which the release tooling guards, or as reviewed compatible.
    /// </summary>
    [Fact]
    public void Every_migration_that_creates_a_trigger_is_registered_as_a_break_or_reviewed_compatible()
    {
        using var registry = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(Production.Root, "tools", "release", "schema-breaks.json")));
        var root = registry.RootElement;
        var listed = root.GetProperty("breaks").EnumerateArray().Concat(root.GetProperty("reviewedCompatible").EnumerateArray())
            .Select(e => $"{e.GetProperty("context").GetString()}/{e.GetProperty("migration").GetString()}")
            .ToHashSet(StringComparer.Ordinal);
        var migrations = MigrationsByContext().ToList();
        var withTriggers = migrations
            .Where(m => Regex.IsMatch(m.Up, @"CREATE\s+(OR\s+ALTER\s+)?TRIGGER", RegexOptions.IgnoreCase))
            .Select(m => $"{m.Context}/{Path.GetFileNameWithoutExtension(m.File)}")
            .ToList();

        withTriggers.ShouldContain("Crm.Billing/20261004011343_ProtectApprovedBilling");
        withTriggers.Where(m => !listed.Contains(m)).ShouldBeEmpty("register in tools/release/schema-breaks.json");
        listed.Where(entry => !migrations.Any(m => $"{m.Context}/{Path.GetFileNameWithoutExtension(m.File)}" == entry)).ShouldBeEmpty("registered migrations must exist");
    }

    [Fact]
    public void The_rule_recognises_a_contract_step()
    {
        // The detector itself, on a synthetic Up(): each of these would break the previous release.
        const string up = """
            migrationBuilder.DropColumn(name: "Notes", schema: "billing", table: "BillingRuns");
            migrationBuilder.AddColumn<string>(name: "Kind", schema: "billing", table: "BillingRuns", type: "nvarchar(16)", maxLength: 16, nullable: false);
            migrationBuilder.AlterColumn<string>(name: "Status", schema: "billing", table: "BillingBases", type: "nvarchar(8)", maxLength: 8, nullable: false, oldClrType: typeof(string), oldType: "nvarchar(32)", oldMaxLength: 32);
            """;
        Destructive.Count(op => up.Contains($"migrationBuilder.{op}(", StringComparison.Ordinal)).ShouldBe(1);
        var calls = ColumnCall().Matches(up).Select(m => m.Groups[2].Value).ToList();
        calls.Count.ShouldBe(2);
        Regex.IsMatch(calls[0], @"defaultValue(Sql)?:").ShouldBeFalse();
        int.Parse(Regex.Match(calls[1], @"(?<!old)maxLength:\s*(\d+)").Groups[1].Value).ShouldBeLessThan(int.Parse(Regex.Match(calls[1], @"oldMaxLength:\s*(\d+)").Groups[1].Value));
    }
}
