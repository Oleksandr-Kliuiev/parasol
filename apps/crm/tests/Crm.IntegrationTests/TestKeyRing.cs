using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Crm.IntegrationTests;

/// <summary>Disposable local key material so integration hosts exercise the same encrypted storage as the VPS.</summary>
internal sealed class TestKeyRing : IDisposable
{
    public string Root { get; } = Directory.CreateTempSubdirectory("parasol-test-keys-").FullName;
    public string CertificatePath => Path.Combine(Root, "certificate.pfx");
    public string KeyRingPath => Path.Combine(Root, "keys");
    public const string Password = "synthetic-test-key-password";

    public TestKeyRing()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Parasol synthetic integration", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(2));
        File.WriteAllBytes(CertificatePath, certificate.Export(X509ContentType.Pfx, Password));
    }

    public void Dispose() => Directory.Delete(Root, recursive: true);
}
