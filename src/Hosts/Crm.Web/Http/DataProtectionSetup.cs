using Azure.Identity;
using Microsoft.AspNetCore.DataProtection;

namespace Crm.Web.Http;

internal static class DataProtectionSetup
{
    /// <summary>
    /// Keys shared by all replicas and preserved across deployments: stored in Blob Storage and wrapped with a Key Vault key
    /// (docs/03-architecture.md §6). Without configuration (local development) the default file-system key ring is used.
    /// </summary>
    public static WebApplicationBuilder AddDataProtection(this WebApplicationBuilder builder)
    {
        var dataProtection = builder.Services.AddDataProtection().SetApplicationName("vardahei-crm");
        var blobUri = builder.Configuration["DataProtection:BlobUri"];
        var keyUri = builder.Configuration["DataProtection:KeyVaultKeyUri"];
        if (Problem(blobUri, keyUri, builder.Environment) is { } problem)
        {
            throw new InvalidOperationException(problem);
        }

        if (!string.IsNullOrWhiteSpace(blobUri) && !string.IsNullOrWhiteSpace(keyUri))
        {
            var credential = new DefaultAzureCredential(new DefaultAzureCredentialOptions
            {
                ManagedIdentityClientId = builder.Configuration["AZURE_CLIENT_ID"],
            });
            dataProtection
                .PersistKeysToAzureBlobStorage(new Uri(blobUri), credential)
                .ProtectKeysWithAzureKeyVault(new Uri(keyUri), credential);
        }

        return builder;
    }

    /// <summary>
    /// DEV-10: in production the key ring must be the shared one — a replica with keys of its own cannot read the cookies of the
    /// others, and its sessions die with it; half a configuration is refused everywhere.
    /// </summary>
    internal static string? Problem(string? blobUri, string? keyUri, IHostEnvironment environment)
    {
        var blob = !string.IsNullOrWhiteSpace(blobUri);
        var key = !string.IsNullOrWhiteSpace(keyUri);
        if (blob != key)
        {
            return "DataProtection:BlobUri and DataProtection:KeyVaultKeyUri go together: set both or neither.";
        }

        return !blob && environment.IsProduction()
            ? "Production needs DataProtection:BlobUri and DataProtection:KeyVaultKeyUri: every replica must share one key ring (DEV-10)."
            : null;
    }
}
