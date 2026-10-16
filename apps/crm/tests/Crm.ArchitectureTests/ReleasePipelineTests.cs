using System.Text.RegularExpressions;

namespace Crm.ArchitectureTests;

/// <summary>
/// The release pipeline as the workflows and scripts define it (DEV-05, docs/adr/ADR-015-release-pipeline.md): a red CI job
/// stops the release, production gets only the tested digests, migrations come before any revision or traffic change,
/// nothing privileged runs untrusted code. Real repository settings (reviewers, branch protection) are EXT-11.
/// </summary>
public partial class ReleasePipelineTests
{
    private static readonly string Workflows = Path.Combine(Production.Root, ".github", "workflows");

    private static string Workflow(string name) => File.ReadAllText(Path.Combine(Workflows, name));

    private static string Tool(string name) => File.ReadAllText(Path.Combine(Production.Root, "tools", "release", name));

    /// <summary>The <c>on:</c> section of a workflow.</summary>
    private static string Triggers(string workflow) => Regex.Match(workflow, @"(?ms)^on:\s*\n(.*?)^\S").Groups[1].Value;

    /// <summary>The jobs of a workflow: two-space indented keys under <c>jobs:</c>.</summary>
    private static List<string> Jobs(string workflow)
    {
        var jobs = workflow[(workflow.IndexOf("\njobs:\n", StringComparison.Ordinal) + 7)..];
        return JobKey().Matches(jobs).Select(m => m.Groups[1].Value).ToList();
    }

    /// <summary>The text of one job, up to the next job.</summary>
    private static string Job(string workflow, string name)
    {
        var start = workflow.IndexOf($"\n  {name}:\n", StringComparison.Ordinal);
        start.ShouldBeGreaterThan(0, $"job {name} not found");
        var next = JobKey().Match(workflow, start + name.Length + 4);
        return next.Success ? workflow[start..next.Index] : workflow[start..];
    }

    [GeneratedRegex(@"^  ([a-z0-9-]+):\s*$", RegexOptions.Multiline)]
    private static partial Regex JobKey();

    [Fact]
    public void Every_required_ci_job_gates_the_release()
    {
        var ci = Workflow("ci.yml");
        var release = Job(ci, "release");
        var needs = Regex.Match(release, @"needs:\s*\[([^\]]*)\]").Groups[1].Value.Split(',').Select(n => n.Trim()).Order(StringComparer.Ordinal).ToList();

        // A job added to CI is a required check unless someone decides otherwise here.
        needs.ShouldBe(Jobs(ci).Where(j => j != "release").Order(StringComparer.Ordinal).ToList());
        release.ShouldContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
        release.ShouldContain("uses: ./.github/workflows/release.yml");
        release.ShouldNotContain("always()");
        release.ShouldNotContain("continue-on-error");
        ci.ShouldContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    }

    [Fact]
    public void Only_the_release_and_promotion_workflows_reach_an_environment()
    {
        foreach (var file in Directory.GetFiles(Workflows, "*.yml"))
        {
            var text = File.ReadAllText(file);
            var name = Path.GetFileName(file);
            // Triggers that run with the repository's privileges on behalf of someone else's code.
            Triggers(text).ShouldNotContain("pull_request_target", customMessage: name);
            Triggers(text).ShouldNotContain("workflow_run", customMessage: name);
            if (name is not ("release.yml" or "promote.yml"))
            {
                text.ShouldNotContain("azure/login", customMessage: name);
                text.ShouldNotContain("environment:", customMessage: name);
            }
        }

        Triggers(Workflow("release.yml")).Trim().ShouldStartWith("workflow_call:");
        var promote = Workflow("promote.yml");
        Triggers(promote).Trim().ShouldStartWith("workflow_dispatch:");
        Job(promote, "deploy").ShouldContain("needs: verify");
        Job(promote, "deploy").ShouldContain("environment: ${{ inputs.environment }}");
        Job(promote, "verify").ShouldNotContain("id-token: write");
        Job(promote, "verify").ShouldNotContain("azure/login");
    }

    [Fact]
    public void A_promotion_never_rebuilds_and_checks_the_tested_release_first()
    {
        var promote = Workflow("promote.yml");
        foreach (var build in new[] { "dotnet publish", "PublishContainer", "docker build", "npm run build", "npm ci" })
        {
            promote.ShouldNotContain(build);
        }

        var verify = Job(promote, "verify");
        verify.ShouldContain("release.py promotion-check");
        verify.ShouldContain("--workflow ci.yml --branch main --event push --commit \"$SHA\"");
        verify.ShouldContain("release / deploy-test");
        promote.ShouldContain("gh attestation verify");
        promote.ShouldContain("az acr import");
        // A dispatch input reaches a script only through the environment, never pasted into it (script injection).
        foreach (var script in RunScripts(promote))
        {
            script.ShouldNotContain("${{ inputs.");
            script.ShouldNotContain("github.event.inputs");
        }
    }

    /// <summary>The shell scripts of a workflow: single-line <c>run:</c> values and the indented blocks of <c>run: |</c>.</summary>
    private static List<string> RunScripts(string workflow)
    {
        var scripts = new List<string>();
        var lines = workflow.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var run = Regex.Match(lines[i], @"^(\s*)(?:- )?run:\s*(.*)$");
            if (!run.Success)
            {
                continue;
            }

            if (run.Groups[2].Value is not ("|" or ">-" or ">"))
            {
                scripts.Add(run.Groups[2].Value);
                continue;
            }

            var indent = run.Groups[1].Value.Length;
            var block = new List<string>();
            while (i + 1 < lines.Length && (lines[i + 1].Trim().Length == 0 || lines[i + 1].Length - lines[i + 1].TrimStart().Length > indent))
            {
                block.Add(lines[++i]);
            }

            scripts.Add(string.Join('\n', block));
        }

        return scripts;
    }

    [Fact]
    public void Migrations_run_before_any_revision_or_traffic_change()
    {
        var deploy = Tool("deploy.sh");
        var migrations = deploy.IndexOf("az containerapp job start", StringComparison.Ordinal);
        var failure = deploy.IndexOf("the migration failed: no revision and no traffic was changed", StringComparison.Ordinal);
        var bicep = deploy.IndexOf("az deployment group create", StringComparison.Ordinal);
        var candidateSmoke = deploy.IndexOf("smoke-candidate.json", StringComparison.Ordinal);
        var traffic = deploy.IndexOf("ingress traffic set", StringComparison.Ordinal);
        migrations.ShouldBeGreaterThan(0);
        failure.ShouldBeInRange(migrations, bicep);
        bicep.ShouldBeLessThan(candidateSmoke);
        candidateSmoke.ShouldBeLessThan(traffic);
        deploy.ShouldContain("set -euo pipefail");

        foreach (var workflow in new[] { "release.yml", "promote.yml" })
        {
            var text = Workflow(workflow);
            text.ShouldContain("tools/release/deploy.sh");
            text.ShouldNotContain("continue-on-error");
            text.ShouldNotContain("always()");
        }
    }

    [Fact]
    public void The_schema_guard_runs_before_anything_in_the_environment_changes()
    {
        var release = Workflow("release.yml");
        release.IndexOf("release.py schema-guard", StringComparison.Ordinal).ShouldBeInRange(0, release.IndexOf("tools/release/deploy.sh", StringComparison.Ordinal));
        var promote = Workflow("promote.yml");
        var guard = promote.IndexOf("release.py schema-guard", StringComparison.Ordinal);
        guard.ShouldBeGreaterThan(0);
        guard.ShouldBeLessThan(promote.IndexOf("az acr import", StringComparison.Ordinal));
        guard.ShouldBeLessThan(promote.IndexOf("tools/release/deploy.sh", StringComparison.Ordinal));
        // Production accepts a schema break only when the operator says a maintenance window is arranged.
        promote.ShouldContain("[[ \"$ACCEPT_SCHEMA_BREAK\" == true ]] && args+=(--accept-break)");
        File.ReadAllText(Path.Combine(Production.Root, "infra", "modules", "apps.bicep")).ShouldContain("crmRelease: releaseCommit");
    }

    [Fact]
    public void Probes_follow_readiness_and_liveness_and_migrations_only_run_no_processing()
    {
        // DEV-06: --migrate-only returns before the host runs, so no hosted processing starts in the migration job.
        var web = File.ReadAllText(Path.Combine(Production.Root, "src", "Hosts", "Crm.Web", "Program.cs"));
        var migrateOnly = web.IndexOf("args.Contains(DatabaseMigrator.MigrateOnlyArgument)", StringComparison.Ordinal);
        migrateOnly.ShouldBeGreaterThan(0);
        web.IndexOf("return;", migrateOnly, StringComparison.Ordinal).ShouldBeLessThan(web.IndexOf("app.Run", StringComparison.Ordinal));
        web.ShouldContain("AddDatabaseReadiness()");

        var worker = File.ReadAllText(Path.Combine(Production.Root, "src", "Hosts", "Crm.Worker", "Program.cs"));
        worker.ShouldContain("AddOutboxProcessing()");
        worker.ShouldContain("AddDatabaseReadiness()");
        worker.ShouldNotContain("AddHostedService<OutboxProcessor>");
        worker.ShouldContain("WorkerHeartbeatJob.JobId");

        var apps = File.ReadAllText(Path.Combine(Production.Root, "infra", "modules", "apps.bicep"));
        var workerApp = apps[apps.IndexOf("resource worker ", StringComparison.Ordinal)..apps.IndexOf("resource migrate ", StringComparison.Ordinal)];
        workerApp.ShouldContain("type: 'Liveness', httpGet: { path: '/health/live'");
        workerApp.ShouldContain("type: 'Readiness', httpGet: { path: '/health/ready'");
        apps.ShouldContain("type: 'Readiness', httpGet: { path: '/health/ready', port: 8080 }, periodSeconds: 10, timeoutSeconds: 5");
    }

    [Fact]
    public void Every_action_is_pinned_to_a_commit()
    {
        foreach (var file in Directory.GetFiles(Workflows, "*.yml"))
        {
            foreach (Match use in Regex.Matches(File.ReadAllText(file), @"uses:\s*([^\s#]+)"))
            {
                var action = use.Groups[1].Value;
                if (!action.StartsWith("./", StringComparison.Ordinal))
                {
                    action.ShouldMatch(@"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$", $"{Path.GetFileName(file)}: {action}");
                }
            }
        }
    }

    [Fact]
    public void A_scanner_that_could_not_run_fails_the_build()
    {
        var ci = Workflow("ci.yml");
        ci.ShouldNotContain("--omit=dev");
        ci.ShouldContain("release.py vulnerable-dotnet");
        ci.ShouldContain("release.py npm-audit");
        ci.ShouldContain("python3 -m unittest discover -s tools/release");
        Regex.Count(ci, @"\|\s*tee\b").ShouldBe(0);
        var release = Workflow("release.yml");
        release.ShouldContain("fail-build: true");
        release.ShouldContain("severity-cutoff: high");
        release.ShouldContain("release.py scan-secrets");
    }

    [Fact]
    public void Images_are_deployed_by_digest_and_each_environment_has_its_own_PowerOffice()
    {
        var apps = File.ReadAllText(Path.Combine(Production.Root, "infra", "modules", "apps.bicep"));
        apps.ShouldContain("/crm-web@${webImageDigest}");
        apps.ShouldContain("/crm-worker@${workerImageDigest}");
        apps.ShouldNotContain("imageTag");
        apps.ShouldContain("{ name: 'Deployment__Environment', value: environmentName }");

        var main = File.ReadAllText(Path.Combine(Production.Root, "infra", "main.bicep"));
        Regex.IsMatch(main, @"param powerOfficeEnvironment string\s*\n").ShouldBeTrue("no default for the PowerOffice environment");
        File.ReadAllText(Path.Combine(Production.Root, "infra", "env", "prod.bicepparam")).ShouldContain("param powerOfficeEnvironment = 'Production'");
        File.ReadAllText(Path.Combine(Production.Root, "infra", "env", "test.bicepparam")).ShouldContain("param powerOfficeEnvironment = 'Demo'");
        foreach (var file in Directory.GetFiles(Workflows, "*.yml"))
        {
            File.ReadAllText(file).ShouldNotContain("CRM_POWEROFFICE_ENVIRONMENT", customMessage: Path.GetFileName(file));
        }
    }
}
