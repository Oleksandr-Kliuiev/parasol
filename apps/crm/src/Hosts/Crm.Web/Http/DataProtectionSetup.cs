using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.Web.Http;

internal static class DataProtectionSetup
{
    /// <summary>Hostinger: persistent key ring on the VPS, encrypted with a mounted certificate. No cloud key service.</summary>
    public static WebApplicationBuilder AddDataProtection(this WebApplicationBuilder builder)
    {
        // Preserve the discriminator so existing CRM cookies can survive with the same key ring.
        var protection = builder.Services.AddDataProtection().SetApplicationName("vardahei-crm");
        var config = builder.Configuration.GetSection("DataProtection");
        if (!string.IsNullOrWhiteSpace(config["BlobUri"]) || !string.IsNullOrWhiteSpace(config["KeyVaultKeyUri"]))
            throw new InvalidOperationException("Azure key storage is not supported by Parasol. Configure the VPS key ring and certificate.");
        var path = config["KeyRingPath"];
        var certificatePath = config["CertificatePath"];
        var hasPath = !string.IsNullOrWhiteSpace(path);
        var hasCertificate = !string.IsNullOrWhiteSpace(certificatePath);
        if (hasPath != hasCertificate)
            throw new InvalidOperationException("DataProtection:KeyRingPath and DataProtection:CertificatePath go together: set both or neither.");
        if (!hasPath)
        {
            if (!builder.Environment.IsDevelopment())
                throw new InvalidOperationException("Outside Development, all instances must share one key ring: configure DataProtection:KeyRingPath and CertificatePath.");
            return builder;
        }
        if (!Path.IsPathFullyQualified(path!) || !Path.IsPathFullyQualified(certificatePath!))
            throw new InvalidOperationException("DataProtection key ring and certificate paths must be absolute.");
        // macOS cannot import PKCS#12 with EphemeralKeySet; Linux/VPS keeps the loaded private key in memory.
        var flags = OperatingSystem.IsMacOS() ? X509KeyStorageFlags.DefaultKeySet : X509KeyStorageFlags.EphemeralKeySet;
        var certificate = X509CertificateLoader.LoadPkcs12FromFile(certificatePath!, config["CertificatePassword"], flags);
        using var privateKey = certificate.GetRSAPrivateKey();
        if (privateKey is null)
            throw new InvalidOperationException("DataProtection requires a certificate with its RSA private key.");
        protection.PersistKeysToFileSystem(new DirectoryInfo(path!)).ProtectKeysWithCertificate(certificate);
        // Keep old certificates mounted until every key encrypted with them has been retired.
        var oldCertificates = config.GetSection("PreviousCertificatePaths").Get<string[]>() ?? [];
        if (oldCertificates.Any(p => !Path.IsPathFullyQualified(p)))
            throw new InvalidOperationException("DataProtection previous certificate paths must be absolute.");
        protection.UnprotectKeysWithAnyCertificate([certificate, .. oldCertificates.Select(p =>
            X509CertificateLoader.LoadPkcs12FromFile(p, config["CertificatePassword"], flags))]);
        return builder;
    }
}
