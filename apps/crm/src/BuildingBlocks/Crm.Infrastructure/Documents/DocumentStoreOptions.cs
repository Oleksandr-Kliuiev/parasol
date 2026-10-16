using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Documents;

public enum DocumentStoreProvider
{
    FileSystem,

    // Retained only to reject an obsolete configuration explicitly, never to fall back silently.
    AzureBlob,
}

public sealed class DocumentStoreOptions
{
    public const string SectionName = "Documents";

    public DocumentStoreProvider Provider { get; set; } = DocumentStoreProvider.FileSystem;

    /// <summary>Production requires an existing absolute path on a private persistent local volume shared by web and worker.</summary>
    public string RootPath { get; set; } = "data/documents";

    /// <summary>Non-secret UUID in .parasol-volume. Detects a missing mount or the wrong environment's volume.</summary>
    public string? VolumeId { get; set; }
}

internal sealed class DocumentStoreOptionsValidation(IHostEnvironment environment) : IValidateOptions<DocumentStoreOptions>
{
    public ValidateOptionsResult Validate(string? name, DocumentStoreOptions options)
    {
        if (options.Provider != DocumentStoreProvider.FileSystem)
        {
            return ValidateOptionsResult.Fail("Documents:Provider must be FileSystem. AzureBlob is retired; migrate the objects before switching providers.");
        }

        if (string.IsNullOrWhiteSpace(options.RootPath))
        {
            return ValidateOptionsResult.Fail("Documents:RootPath is required.");
        }

        if (environment.IsProduction() && (!Path.IsPathFullyQualified(options.RootPath) || !Directory.Exists(options.RootPath)))
        {
            return ValidateOptionsResult.Fail("Documents:RootPath must be an existing absolute path on a persistent volume in production.");
        }

        if ((environment.IsProduction() || options.VolumeId is not null) && !Guid.TryParseExact(options.VolumeId, "D", out _))
        {
            return ValidateOptionsResult.Fail("Documents:VolumeId must be the UUID provisioned in .parasol-volume; it is required in production.");
        }

        var root = Path.GetFullPath(options.RootPath, environment.ContentRootPath).TrimEnd(Path.DirectorySeparatorChar);
        var publicRoot = Path.Combine(environment.ContentRootPath, "wwwroot");
        return root.Equals(publicRoot, StringComparison.OrdinalIgnoreCase) || root.StartsWith(publicRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            ? ValidateOptionsResult.Fail("Documents:RootPath must be outside wwwroot; documents are served only through the authorized API.")
            : ValidateOptionsResult.Success;
    }
}

// Force the real store's capability probe before either host accepts work, even if no document service is used at startup.
internal sealed class DocumentStoreStartup(Crm.SharedKernel.Documents.IDocumentStore store) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        GC.KeepAlive(store);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
