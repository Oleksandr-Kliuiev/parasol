using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Documents;
using Crm.SharedKernel.Documents;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>Production fails closed without a pre-provisioned private persistent directory.</summary>
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
    public async Task Production_refuses_an_implicit_or_relative_folder()
    {
        foreach (var settings in new[] { new Dictionary<string, string?>(), new() { ["Documents:Provider"] = "FileSystem" } })
        {
            await using var services = Services("Production", settings);
            Should.Throw<OptionsValidationException>(() => services.GetRequiredService<IDocumentStore>())
                .Message.ShouldContain("existing absolute path");
        }
    }

    [Theory]
    [InlineData("AzureBlob")]
    [InlineData("99")]
    public async Task Obsolete_or_unknown_providers_never_fall_back_to_a_folder(string provider)
    {
        await using var services = Services("Production", new() { ["Documents:Provider"] = provider });
        Should.Throw<OptionsValidationException>(() => services.GetRequiredService<IDocumentStore>()).Message.ShouldContain("must be FileSystem");
    }

    [Fact]
    public async Task Production_uses_an_existing_absolute_folder_and_refuses_missing_or_public_storage()
    {
        var root = Path.Combine(Path.GetTempPath(), $"crm-persistent-{Guid.NewGuid():N}");
        var volumeId = Guid.NewGuid().ToString("D");
        try
        {
            await using (var missing = Services("Production", new() { ["Documents:RootPath"] = root }))
            {
                Should.Throw<OptionsValidationException>(() => missing.GetRequiredService<IDocumentStore>()).Message.ShouldContain("existing absolute path");
                Directory.Exists(root).ShouldBeFalse();
            }

            Directory.CreateDirectory(root);
            await File.WriteAllTextAsync(Path.Combine(root, ".parasol-volume"), volumeId, TestContext.Current.CancellationToken);
            await using var configured = Services("Production", new() { ["Documents:RootPath"] = root, ["Documents:VolumeId"] = volumeId });
            var store = configured.GetRequiredService<IDocumentStore>().ShouldBeOfType<FileSystemDocumentStore>();
            await store.PutAsync("quotes/production.pdf", "%PDF-1.4"u8.ToArray(), "application/pdf", TestContext.Current.CancellationToken);
            Directory.CreateDirectory(Path.Combine(root, "wwwroot", "documents"));
            await using var publicStore = Services("Production", new() { ["Documents:RootPath"] = Path.Combine(root, "wwwroot", "documents"), ["Documents:VolumeId"] = volumeId }, root);
            Should.Throw<OptionsValidationException>(() => publicStore.GetRequiredService<IDocumentStore>()).Message.ShouldContain("outside wwwroot");
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
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
