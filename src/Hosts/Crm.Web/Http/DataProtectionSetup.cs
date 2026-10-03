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
}
