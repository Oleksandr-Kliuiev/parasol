using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>Where issued documents go (DEV-08): a folder only outside production; a blob container needs its address.</summary>
public class DocumentStoreOptionsTests
{
    [Fact]
    public async Task Outside_production_a_relative_folder_is_taken_from_the_content_root()
    {
        var contentRoot = Path.Combine(Path.GetTempPath(), $"crm-content-{Guid.NewGuid():N}");
        try
        {
            await using var services = Services("Development", new() { ["Documents:Provider"] = "FileSystem", ["Documents:RootPath"] = "store" }, contentRoot);
            var store = services.GetRequiredService<IDocumentStore>().ShouldBeOfType<FileSystemDocumentStore>();

            await store.PutAsync("quotes/a/b.pdf", "%PDF-1.4"u8.ToArray(), "application/pdf", TestContext.Current.CancellationToken);

            File.Exists(Path.Combine(contentRoot, "store", "quotes", "a", "b.pdf")).ShouldBeTrue();
        }
        finally
        {
            if (Directory.Exists(contentRoot))
            {
                Directory.Delete(contentRoot, recursive: true);
            }
        }
    }

    [Fact]
    public async Task Production_refuses_the_folder_store_also_when_it_is_left_on_the_default()
    {
        foreach (var settings in new[] { new Dictionary<string, string?>(), new() { ["Documents:Provider"] = "FileSystem" } })
        {
            await using var services = Services("Production", settings);
            Should.Throw<OptionsValidationException>(() => services.GetRequiredService<IDocumentStore>())
                .Message.ShouldContain("production uses AzureBlob");
        }
    }

    [Fact]
    public async Task The_blob_store_needs_the_container_address_and_takes_the_apps_identity()
    {
        await using (var missing = Services("Production", new() { ["Documents:Provider"] = "AzureBlob" }))
        {
            Should.Throw<OptionsValidationException>(() => missing.GetRequiredService<IDocumentStore>()).Message.ShouldContain("BlobContainerUri");
        }

        await using var configured = Services("Production", new()
        {
            ["Documents:Provider"] = "AzureBlob",
            ["Documents:BlobContainerUri"] = "https://stcrmtest.blob.core.windows.net/documents",
            ["AZURE_CLIENT_ID"] = "00000000-0000-0000-0000-00000000c1d0",
        });
        configured.GetRequiredService<IDocumentStore>().ShouldBeOfType<AzureBlobDocumentStore>();
        configured.GetRequiredService<IOptions<DocumentStoreOptions>>().Value.ManagedIdentityClientId.ShouldBe("00000000-0000-0000-0000-00000000c1d0");
    }

    private static ServiceProvider Services(string environment, Dictionary<string, string?> settings, string? contentRoot = null)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
        services.AddSingleton<IHostEnvironment>(new TestEnvironment(environment, contentRoot ?? Path.GetTempPath()));
        services.AddCrmInfrastructure();
        return services.BuildServiceProvider();
    }

    private sealed class TestEnvironment(string name, string contentRoot) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;

        public string ApplicationName { get; set; } = "Crm.UnitTests";

        public string ContentRootPath { get; set; } = contentRoot;

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
