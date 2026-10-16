using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Crm.Web.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public sealed class VpsDataProtectionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "parasol-keys-" + Guid.NewGuid().ToString("N"));

    private string Certificate(string name)
    {
        Directory.CreateDirectory(_root);
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Parasol synthetic test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(2));
        var path = Path.Combine(_root, name + ".pfx");
        File.WriteAllBytes(path, certificate.Export(X509ContentType.Pfx, "synthetic-test-password"));
        return path;
    }

    private WebApplicationBuilder Builder(string environment, string? certificate = null, string? previous = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["DataProtection:KeyRingPath"] = certificate is null ? null : Path.Combine(_root, "keys"),
            ["DataProtection:CertificatePath"] = certificate,
            ["DataProtection:CertificatePassword"] = "synthetic-test-password",
        });
        if (previous is not null) builder.Configuration["DataProtection:PreviousCertificatePaths:0"] = previous;
        return builder;
    }

    [Fact]
    public async Task Encrypted_keys_survive_restart_and_certificate_rotation_without_Azure()
    {
        var firstCertificate = Certificate("first");
        var firstBuilder = Builder("Production", firstCertificate).AddDataProtection();
        string payload;
        await using (var first = firstBuilder.Build())
            payload = first.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("session-test").Protect("synthetic-session");
        var xml = string.Join('\n', Directory.GetFiles(Path.Combine(_root, "keys"), "*.xml").Select(File.ReadAllText));
        xml.ShouldContain("encryptedSecret"); xml.ShouldNotContain("<masterKey");
        await using (var restarted = Builder("Production", firstCertificate).AddDataProtection().Build())
            restarted.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("session-test").Unprotect(payload).ShouldBe("synthetic-session");
        await using (var rotated = Builder("Production", Certificate("next"), firstCertificate).AddDataProtection().Build())
            rotated.Services.GetRequiredService<IDataProtectionProvider>().CreateProtector("session-test").Unprotect(payload).ShouldBe("synthetic-session");
    }

    [Theory]
    [InlineData("Production")]
    [InlineData("Staging")]
    public void Nondevelopment_hosts_require_persistent_encrypted_keys(string environment) =>
        Should.Throw<InvalidOperationException>(() => Builder(environment).AddDataProtection()).Message.ShouldContain("share one key ring");

    [Fact]
    public void Azure_storage_and_relative_paths_are_rejected()
    {
        var azure = Builder("Development");
        azure.Configuration["DataProtection:BlobUri"] = "https://example.invalid/keys";
        Should.Throw<InvalidOperationException>(() => azure.AddDataProtection()).Message.ShouldContain("not supported");
        var relative = Builder("Development", "relative.pfx");
        Should.Throw<InvalidOperationException>(() => relative.AddDataProtection()).Message.ShouldContain("absolute");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
