using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;
using Crm.Integrations.MicrosoftGraph;

namespace Crm.UnitTests;

public sealed class FileGraphCredentialTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "parasol-graph-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Disabled_integration_never_falls_back_to_machine_or_developer_credentials()
    {
        var credential = FileGraphCredential.Create(new GraphOptions());
        var context = new TokenRequestContext(["https://graph.microsoft.com/.default"]);
        Should.Throw<CredentialUnavailableException>(() => credential.GetToken(context, default));
        await Should.ThrowAsync<CredentialUnavailableException>(async () => await credential.GetTokenAsync(context, default));
    }

    [Fact]
    public void Managed_identity_is_rejected_even_when_disabled()
    {
        Should.Throw<InvalidOperationException>(() => FileGraphCredential.Create(new GraphOptions
        {
            ManagedIdentityClientId = Guid.NewGuid().ToString(),
        })).Message.ShouldContain("unsupported on VPS");
    }

    [Theory]
    [InlineData(null, null, null)]
    [InlineData("common", "00000000-0000-0000-0000-000000000001", "/tmp/file.pfx")]
    [InlineData("00000000-0000-0000-0000-000000000002", "bad-client", "/tmp/file.pfx")]
    [InlineData("00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000001", "relative.pfx")]
    public void Enabled_application_requires_explicit_certificate_configuration(string? tenant, string? client, string? path)
    {
        Should.Throw<InvalidOperationException>(() => FileGraphCredential.Create(new GraphOptions
        {
            Enabled = true, TenantId = tenant, ClientId = client, CertificatePath = path,
        }));
    }

    [Fact]
    public void Mounted_private_certificate_is_loaded_without_requesting_a_token()
    {
        using var credential = (IDisposable)FileGraphCredential.Create(Options(privateKey: true));
        credential.ShouldBeOfType<FileGraphCredential>();
    }

    [Fact]
    public void Public_certificate_alone_is_rejected()
    {
        Should.Throw<InvalidOperationException>(() => FileGraphCredential.Create(Options(privateKey: false)))
            .Message.ShouldContain("private key");
    }

    private GraphOptions Options(bool privateKey)
    {
        Directory.CreateDirectory(root);
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Parasol synthetic Graph", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var publicOnly = X509CertificateLoader.LoadCertificate(cert.Export(X509ContentType.Cert));
        var path = Path.Combine(root, "graph.pfx");
        File.WriteAllBytes(path, (privateKey ? cert : publicOnly).Export(X509ContentType.Pfx, "synthetic"));
        return new GraphOptions
        {
            Enabled = true, TenantId = Guid.NewGuid().ToString(), ClientId = Guid.NewGuid().ToString(),
            CertificatePath = path, CertificatePassword = "synthetic",
        };
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
