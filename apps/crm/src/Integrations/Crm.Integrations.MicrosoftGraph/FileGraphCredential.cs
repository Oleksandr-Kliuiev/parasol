using System.Security.Cryptography.X509Certificates;
using Azure.Core;
using Azure.Identity;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>Explicit Microsoft 365 app certificate; never probes a cloud or developer credential chain.</summary>
internal sealed class FileGraphCredential : TokenCredential, IDisposable
{
    private readonly X509Certificate2 certificate;
    private readonly ClientCertificateCredential credential;

    private FileGraphCredential(GraphOptions options)
    {
        certificate = X509CertificateLoader.LoadPkcs12FromFile(options.CertificatePath!, options.CertificatePassword,
            OperatingSystem.IsMacOS() ? X509KeyStorageFlags.DefaultKeySet : X509KeyStorageFlags.EphemeralKeySet);
        if (!certificate.HasPrivateKey)
        {
            certificate.Dispose();
            throw new InvalidOperationException("MicrosoftGraph certificate must contain a private key.");
        }

        credential = new ClientCertificateCredential(options.TenantId, options.ClientId, certificate);
    }

    internal static TokenCredential Create(GraphOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.ManagedIdentityClientId))
        {
            throw new InvalidOperationException("MicrosoftGraph managed identity is unsupported on VPS; configure a file certificate.");
        }

        if (!options.Enabled && string.IsNullOrWhiteSpace(options.ClientId))
        {
            return new UnconfiguredCredential();
        }

        if (!Guid.TryParse(options.TenantId, out _) || !Guid.TryParse(options.ClientId, out _)
            || string.IsNullOrWhiteSpace(options.CertificatePath) || !Path.IsPathFullyQualified(options.CertificatePath))
        {
            throw new InvalidOperationException("MicrosoftGraph needs TenantId, ClientId and an absolute CertificatePath.");
        }

        return new FileGraphCredential(options);
    }

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
        => credential.GetToken(requestContext, cancellationToken);

    public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
        => credential.GetTokenAsync(requestContext, cancellationToken);

    public void Dispose() => certificate.Dispose();

    private sealed class UnconfiguredCredential : TokenCredential
    {
        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
            => throw new CredentialUnavailableException("MicrosoftGraph application credentials are not configured.");

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
            => throw new CredentialUnavailableException("MicrosoftGraph application credentials are not configured.");
    }
}
