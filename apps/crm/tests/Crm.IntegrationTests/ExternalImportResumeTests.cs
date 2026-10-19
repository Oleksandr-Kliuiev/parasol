using Crm.Authorization;
using Crm.Catalog.Persistence;
using Crm.Customers.Persistence;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.PowerOffice;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

[Collection(nameof(PowerOfficeResumeCollection))]
public class ExternalImportResumeTests(CrmWebFactory factory)
{
    [Theory]
    [InlineData("Customer")]
    [InlineData("ContactPerson")]
    [InlineData("Product")]
    public async Task Restart_after_entity_commit_before_link_creates_no_duplicate(string type)
    {
        var fault = new LinkFailure();
        await using var host = Host(fault);
        var source = await Seed(host, type);
        fault.ExternalId = source.ExternalId;
        fault.Type = type;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var first = await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportOneAsync("poweroffice", type, source.ExternalId, CancellationToken.None);
            first.IsSuccess.ShouldBeFalse();
            first.Error!.Code.ShouldBe("INT_IMPORT_DB_FAILED");
        }
        (await CountCreated(host.Services, type, source.DisplayName)).ShouldBe(1);

        // Preview must report recovery rather than silently skipping a same-name company without an org number.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var preview = await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportUnlinkedAsync("poweroffice", type, dryRun: true, CancellationToken.None);
            preview.IsSuccess.ShouldBeTrue();
            preview.Value.Linked.ShouldBeGreaterThanOrEqualTo(1);
        }
        (await CountCreated(host.Services, type, source.DisplayName)).ShouldBe(1);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            await using var scope = host.Services.CreateAsyncScope();
            var replay = await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportOneAsync("poweroffice", type, source.ExternalId, CancellationToken.None);
            replay.IsSuccess.ShouldBeTrue();
            replay.Value.ShouldBe(source.Id);
        }
        (await CountCreated(host.Services, type, source.DisplayName)).ShouldBe(1);
        await using var check = host.Services.CreateAsyncScope();
        (await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks
            .CountAsync(l => l.System == "poweroffice" && l.ExternalType == type && l.ExternalId == source.ExternalId)).ShouldBe(1);
        (await check.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks
            .SingleAsync(l => l.System == "poweroffice" && l.ExternalType == type && l.ExternalId == source.ExternalId)).Method.ShouldBe(LinkMethod.Imported);
    }

    [Theory]
    [InlineData("Customer")]
    [InlineData("ContactPerson")]
    [InlineData("Product")]
    public async Task Concurrent_creation_of_the_same_source_record_is_idempotent(string type)
    {
        await using var host = Host(new LinkFailure());
        var source = await Seed(host, type);
        async Task<bool> Import()
        {
            await using var scope = host.Services.CreateAsyncScope();
            var result = await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportOneAsync("poweroffice", type, source.ExternalId, CancellationToken.None);
            return result.IsSuccess;
        }
        (await Task.WhenAll(Import(), Import())).ShouldContain(true);
        (await Import()).ShouldBeTrue();
        (await CountCreated(host.Services, type, source.DisplayName)).ShouldBe(1);
    }

    [Theory]
    [InlineData("Customer")]
    [InlineData("ContactPerson")]
    [InlineData("Product")]
    public async Task Recovery_does_not_recreate_a_deleted_import_target(string type)
    {
        var fault = new LinkFailure();
        await using var host = Host(fault);
        var source = await Seed(host, type);
        fault.ExternalId = source.ExternalId;
        fault.Type = type;
        await using (var scope = host.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportOneAsync("poweroffice", type, source.ExternalId, CancellationToken.None)).IsSuccess.ShouldBeFalse();
        }
        await using (var scope = host.Services.CreateAsyncScope())
        {
            if (type == "Product")
            {
                var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
                (await db.Products.SingleAsync(p => p.Id == source.Id)).MarkDeleted();
                await db.SaveChangesAsync();
            }
            else
            {
                var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
                if (type == "Customer") (await db.Organizations.SingleAsync(o => o.Id == source.Id)).MarkDeleted();
                else (await db.Contacts.SingleAsync(c => c.Id == source.Id)).Pseudonymize("synthetic-m37-erasure");
                await db.SaveChangesAsync();
            }
        }
        await using (var scope = host.Services.CreateAsyncScope())
        {
            (await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
                .ImportOneAsync("poweroffice", type, source.ExternalId, CancellationToken.None)).IsSuccess.ShouldBeFalse();
            (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks
                .AnyAsync(l => l.System == "poweroffice" && l.ExternalType == type && l.ExternalId == source.ExternalId)).ShouldBeFalse();
        }
    }

    [Theory]
    [InlineData("Customer")]
    [InlineData("ContactPerson")]
    [InlineData("Product")]
    public async Task Preview_of_a_new_source_record_creates_no_target(string type)
    {
        await using var host = Host(new LinkFailure());
        var source = await Seed(host, type);
        await using var scope = host.Services.CreateAsyncScope();
        var preview = await scope.ServiceProvider.GetRequiredService<ExternalImportService>()
            .ImportUnlinkedAsync("poweroffice", type, dryRun: true, CancellationToken.None);
        preview.IsSuccess.ShouldBeTrue();
        (await CountCreated(host.Services, type, source.DisplayName)).ShouldBe(0);
        (await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalLinks
            .AnyAsync(l => l.System == "poweroffice" && l.ExternalType == type && l.ExternalId == source.ExternalId)).ShouldBeFalse();
    }

    private WebApplicationFactory<Program> Host(LinkFailure fault) => factory.WithWebHostBuilder(builder =>
    {
        builder.UseSetting("Integrations:PowerOffice:WriteEnabled", "false");
        builder.ConfigureServices(services => services.AddDbContext<IntegrationDbContext>((_, options) => options.AddInterceptors(fault)));
    });

    private static async Task<ExternalRecord> Seed(WebApplicationFactory<Program> host, string type)
    {
        var key = Random.Shared.NextInt64(750000000, 759999999);
        var name = $"Synthetic-{Guid.NewGuid():N}";
        var stamp = DateTimeOffset.Parse("2026-10-18T00:00:00Z");
        await using var scope = host.Services.CreateAsyncScope();
        ExternalRecordInput input;
        if (type == "Customer")
        {
            input = PowerOfficeMapping.ToRecord(new PoCustomer(key, key, name, null, null, null, false, null,
                null, null, null, null, null, null, true, false, null, stamp));
        }
        else if (type == "ContactPerson")
        {
            // No e-mail: identity cannot be recovered by matching an address.
            var admin = host.CreateClient();
            admin.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
            admin.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "admin");
            admin.DefaultRequestHeaders.Add("X-CSRF", "1");
            var parent = await admin.CreateOrganizationAsync(new { name = "Parent " + name, status = "Customer" });
            var linked = await scope.ServiceProvider.GetRequiredService<ExternalLinkService>()
                .LinkAsync(EntityTypes.Organization, parent, "poweroffice", "Customer", key.ToString(System.Globalization.CultureInfo.InvariantCulture), LinkMethod.Manual, null, CancellationToken.None);
            linked.IsSuccess.ShouldBeTrue();
            input = PowerOfficeMapping.ToRecord(new PoContactPerson(1, key, name, "", null, null, null, true, true, stamp));
        }
        else input = PowerOfficeMapping.ToRecord(new PoProduct(key, null, name, null, null, null, 10m, null, false, stamp));
        return (await scope.ServiceProvider.GetRequiredService<ExternalRecordStore>().UpsertAsync(input, CancellationToken.None)).Record;
    }

    private static async Task<int> CountCreated(IServiceProvider services, string type, string name)
    {
        await using var scope = services.CreateAsyncScope();
        if (type == "Product") return await scope.ServiceProvider.GetRequiredService<CatalogDbContext>().Products.CountAsync(p => p.Name == name);
        var db = scope.ServiceProvider.GetRequiredService<CustomersDbContext>();
        return type == "Customer" ? await db.Organizations.CountAsync(o => o.Name == name) : await db.Contacts.CountAsync(c => c.FirstName == name);
    }

    private sealed class LinkFailure : SaveChangesInterceptor
    {
        public string? ExternalId { get; set; }
        public string? Type { get; set; }
        private int _fired;

        public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            if (eventData.Context!.ChangeTracker.Entries<ExternalLink>().Any(e => e.State == EntityState.Added &&
                    e.Entity.System == "poweroffice" && e.Entity.ExternalType == Type && e.Entity.ExternalId == ExternalId) && Interlocked.Exchange(ref _fired, 1) == 0)
                throw new DbUpdateException("Synthetic interruption before integration link commit.");
            return ValueTask.FromResult(result);
        }
    }
}
