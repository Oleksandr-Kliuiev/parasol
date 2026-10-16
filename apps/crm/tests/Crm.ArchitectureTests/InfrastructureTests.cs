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

    /// <summary>
    /// Quote documents (DEV-08-AC04) are reached only through the application: the storage account allows no public blob
    /// access, no public network and no shared keys (so no SAS from the account key), the document container is private, the
    /// worker gets that container only, and both hosts use the blob store in Azure — never the file-system one.
    /// </summary>
    [Fact]
    public void Quote_documents_live_in_a_private_container_reached_only_through_the_application()
    {
        var data = Bicep("data.bicep");
        var storage = Block(data, "resource storage ");
        storage.ShouldContain("allowBlobPublicAccess: false");
        storage.ShouldContain("allowSharedKeyAccess: false");
        storage.ShouldContain("publicNetworkAccess: 'Disabled'");
        Block(data, "resource blobService ").ShouldContain("isVersioningEnabled: true");
        Block(data, "resource documentsContainer ").ShouldContain("publicAccess: 'None'");
        var worker = Block(data, "resource workerDocumentsContributor ");
        worker.ShouldContain("scope: documentsContainer");
        worker.ShouldContain("principalId: workerIdentityPrincipalId");

        var common = Block(Bicep("apps.bicep"), "var commonEnv ");
        common.ShouldContain("{ name: 'Documents__Provider', value: 'AzureBlob' }");
        common.ShouldContain("{ name: 'Documents__BlobContainerUri', value: documentsContainerUri }");
    }

    /// <summary>
    /// Record scope (DEV-09) is Restricted unless an environment file says otherwise, and what the file says reaches the apps:
    /// opening it is a reviewed change to infra/env, never a missing setting.
    /// </summary>
    [Fact]
    public void Record_scope_is_restricted_by_default_and_set_per_environment()
    {
        var main = File.ReadAllText(Path.Combine(Production.Root, "infra", "main.bicep"));
        main.ShouldContain("@allowed(['Restricted', 'Open'])\nparam recordScope string = 'Restricted'");
        main.ShouldContain("recordScope: recordScope");
        Block(Bicep("apps.bicep"), "var commonEnv ").ShouldContain("{ name: 'Authorization__RecordScope', value: recordScope }");
        foreach (var environment in new[] { "test", "prod" })
        {
            File.ReadAllText(Path.Combine(Production.Root, "infra", "env", $"{environment}.bicepparam")).ShouldContain("param recordScope = ");
        }
    }

    /// <summary>
    /// DEV-21 (F-G4-02): Partner Center and Teams webhook secrets follow the same rule as the other provider secrets — Key
    /// Vault references resolved by the worker identity, granted one secret at a time, never present on crm-web.
    /// </summary>
    [Fact]
    public void Partner_center_and_teams_secrets_are_per_secret_key_vault_references_for_the_worker()
    {
        var apps = Bicep("apps.bicep");
        var secrets = Block(apps, "var integrationSecrets ");
        var keys = Block(apps, "var integrationKeys ");
        foreach (var name in new[] { "partnercenter-client-secret", "partnercenter-refresh-token", "teams-webhook-sales", "teams-webhook-finance", "teams-webhook-operations" })
        {
            secrets.ShouldContain($"name: '{name}'");
            keys.ShouldContain($"secretRef: '{name}'");
            Block(File.ReadAllText(Path.Combine(Production.Root, "infra", "main.bicep")), "var workerSecretNames ").ShouldContain($"'{name}'");
        }

        Block(apps, "var webEnv ").ShouldNotContain("PartnerCenter");
        Block(apps, "var webEnv ").ShouldNotContain("Teams__Channels");
    }

    /// <summary>DEV-21 (F-G5-01): a broken audit chain is a Sev 1 alert, not only a log line (docs/runbooks/08 §5).</summary>
    [Fact]
    public void Crm_web_gets_its_allowed_hosts_and_trusted_proxy_network_from_the_deployment()
    {
        // DEV-21: Production refuses to start with AllowedHosts '*', and X-Forwarded-* is trusted only from the apps subnet.
        var apps = File.ReadAllText(Path.Combine(Production.Root, "infra", "modules", "apps.bicep"));
        apps.ShouldContain("name: 'AllowedHosts'");
        apps.ShouldContain("name: 'Forwarded__KnownNetworks__0'");
        apps.ShouldContain("---candidate.");
        File.ReadAllText(Path.Combine(Production.Root, "infra", "main.bicep")).ShouldContain("appsSubnetPrefix: network.outputs.appsSubnetPrefix");
    }

    [Fact]
    public void A_mismatch_of_the_audit_chain_raises_a_severity_1_alert()
    {
        var monitoring = Bicep("monitoring-operations.bicep");
        var rule = Block(monitoring, "var declaredRules ");
        var mismatch = rule[rule.IndexOf("id: 'audit-integrity-mismatch'", StringComparison.Ordinal)..];
        mismatch.ShouldContain("severity: 1");
        mismatch.ShouldContain("startswith \"AUDIT_INTEGRITY_MISMATCH\"");
    }
}
