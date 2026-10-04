using System.Text.RegularExpressions;

namespace Crm.ArchitectureTests;

/// <summary>
/// Who may read which secret, as the Bicep templates grant it (DEV-04-AC05, docs/runbooks/08-database-permissions.md):
/// provider secrets reach crm-worker only, and no identity holds a vault-wide role that reads secret values.
/// </summary>
public partial class InfrastructureTests
{
    private static string Bicep(string module) => File.ReadAllText(Path.Combine(Production.Root, "infra", "modules", module));

    /// <summary>The text of one top-level resource or variable, up to the next one.</summary>
    private static string Block(string bicep, string declaration)
    {
        var start = bicep.IndexOf(declaration, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0, $"'{declaration}' not found");
        var next = TopLevel().Match(bicep, start + declaration.Length);
        return next.Success ? bicep[start..next.Index] : bicep[start..];
    }

    [GeneratedRegex(@"^(resource|var|param|output|module) ", RegexOptions.Multiline)]
    private static partial Regex TopLevel();

    [Fact]
    public void Provider_secrets_are_resolved_by_crm_worker_only()
    {
        var apps = Bicep("apps.bicep");
        var web = Block(apps, "resource web ");
        var worker = Block(apps, "resource worker ");

        web.ShouldNotContain("secrets:");
        web.ShouldNotContain("integrationKeys");
        web.ShouldNotContain("workerIdentity");
        web.ShouldContain("env: concat(webEnv, integrationSwitches)");
        worker.ShouldContain("secrets: integrationSecrets");
        worker.ShouldContain("integrationKeys");
        worker.ShouldNotContain("appIdentityId");

        // Every Key Vault reference resolves with the worker identity; no switch variable carries a secret.
        var secrets = Block(apps, "var integrationSecrets ");
        Regex.Matches(secrets, @"identity: (\w+)").Select(m => m.Groups[1].Value).Distinct().ShouldBe(["workerIdentityId"]);
        Block(apps, "var integrationSwitches ").ShouldNotContain("secretRef");
        Block(apps, "var webEnv ").ShouldNotContain("secretRef");
    }

    [Fact]
    public void No_identity_holds_a_vault_wide_role_that_reads_secret_values()
    {
        // Key Vault Secrets User and Certificate User both read secret values; vault-wide they would read every secret.
        const string secretsUser = "4633458b-17de-408a-b874-0445c86b69e6";
        const string certificateUser = "db79e9a7-68ee-4b58-9aeb-b90e7c24fcba";
        var data = Bicep("data.bicep");
        data.ShouldNotContain(secretsUser);
        data.ShouldNotContain(certificateUser);

        var access = Bicep("secret-access.bicep");
        access.ShouldNotContain(certificateUser);
        var web = Block(access, "resource webCertificate ");
        web.ShouldContain("scope: certificateSecret");
        web.ShouldContain("principalId: webPrincipalId");
        var worker = Block(access, "resource workerSecrets ");
        worker.ShouldContain("scope: providerSecrets[i]");
        worker.ShouldContain("principalId: workerPrincipalId");
        Regex.Count(access, @"scope: keyVault\b").ShouldBe(0);
    }

    [Fact]
    public void Each_host_signs_in_to_sql_as_its_own_identity_and_the_migrator_maps_both()
    {
        var apps = Bicep("apps.bicep");
        Block(apps, "var webEnv ").ShouldContain("value: webConnectionString");
        Block(apps, "var workerEnv ").ShouldContain("value: workerConnectionString");
        var migrate = Block(apps, "resource migrate ");
        migrate.ShouldContain("Database__WebIdentityName");
        migrate.ShouldContain("Database__WorkerIdentityName");
        migrate.ShouldNotContain("Database__AppIdentityName");
    }
}
