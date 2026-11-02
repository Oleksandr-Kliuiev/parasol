using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.MicrosoftGraph;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using WireMock.Server;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// A CRM host of its own talking to a Graph stub of its own (M47): SharePoint is switched on with the root folder "Kunder" of the
/// library "drive-sp", the application identity is configured, and writing follows the test's switches. The person's token is the
/// factory's fake one unless <c>connected</c> is false; the application's is the factory's fake credential.
/// </summary>
internal sealed class SharePointHost(WebApplicationFactory<Program> host, WireMockServer graph, string user) : IAsyncDisposable
{
    public const string Drive = "drive-sp";

    public const string Root = "Kunder";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public IServiceProvider Services => host.Services;

    public WireMockServer Graph => graph;

    public static SharePointHost Start(CrmWebFactory factory, bool write = true, bool dryRun = false, bool connected = true)
    {
        var graph = WireMockServer.Start();
        var host = factory.WithWebHostBuilder(builder =>
        {
            builder.UseSetting("Integrations:MicrosoftGraph:BaseUrl", graph.Url + "/graph/v1.0/");
            builder.UseSetting("Integrations:MicrosoftGraph:ClientId", "33333333-3333-3333-3333-333333333333");
            builder.UseSetting("Integrations:MicrosoftGraph:CertificatePath", "/run/secrets/parasol-graph-never-read.pfx");
            builder.UseSetting("Integrations:MicrosoftGraph:SharePoint:DriveId", Drive);
            builder.UseSetting("Integrations:MicrosoftGraph:SharePoint:RootFolder", Root);
            builder.UseSetting("Integrations:MicrosoftGraph:SharePoint:WriteEnabled", write ? "true" : "false");
            builder.UseSetting("Integrations:MicrosoftGraph:SharePoint:DryRun", dryRun ? "true" : "false");
            builder.UseSetting("Integrations:MicrosoftGraph:SharePoint:EnabledActions:0", SharePointActionKinds.FolderCreate);
            if (!connected)
            {
                builder.ConfigureTestServices(services => services.AddScoped<IDelegatedTokenSource, NoPersonToken>());
            }
        });
        // A folder that is not stubbed is not in the root folder.
        graph.Given(Request.Create().WithPath(new WildcardMatcher($"/graph/v1.0/drives/{Drive}/root:/{Root}/*")).UsingGet()).AtPriority(100)
            .RespondWith(Response.Create().WithStatusCode(404));
        return new SharePointHost(host, graph, $"sp-{Guid.NewGuid():N}"[..16]);
    }

    public HttpClient Client(string role = CrmRoles.Admin)
    {
        var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, role);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, user);
        client.DefaultRequestHeaders.Add("X-CSRF", "1");
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return client;
    }

    /// <summary>A folder Graph knows by its id, with the given children (and a next page when <paramref name="more"/>).</summary>
    public void Folder(string id, string name, bool more = false, params object[] children)
    {
        graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{Drive}/items/{id}").UsingGet())
            .RespondWith(JsonReply(Item(id, name, folder: true)));
        graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{Drive}/items/{id}/children").UsingGet())
            .RespondWith(JsonReply(new Dictionary<string, object?>
            {
                ["value"] = children,
                ["@odata.nextLink"] = more ? $"{graph.Url}/graph/v1.0/drives/{Drive}/items/{id}/children?$skiptoken=next" : null,
            }));
    }

    /// <summary>The item answers with this status (404 gone, 403 refused, 500 broken).</summary>
    public void Fails(string id, HttpStatusCode status) =>
        graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{Drive}/items/{id}").UsingGet())
            .RespondWith(Response.Create().WithStatusCode(status));

    /// <summary>
    /// The root folder lists these items (folders and files). A later listing wins over an earlier one: each takes a higher priority.
    /// </summary>
    public void RootLists(params object[] items) =>
        graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{Drive}/root:/{Root}:/children").UsingGet()).AtPriority(_listing--)
            .RespondWith(JsonReply(new { value = items }));

    private int _listing = 50;

    /// <summary>A folder of that name is directly in the root folder (the path may arrive escaped or not).</summary>
    public void InRoot(string id, string name) =>
        graph.Given(Request.Create()
                .WithPath(new WildcardMatcher([$"/graph/v1.0/drives/{Drive}/root:/{Root}/{name}:", $"/graph/v1.0/drives/{Drive}/root:/{Root}/{Uri.EscapeDataString(name)}:"]))
                .UsingGet()).AtPriority(1)
            .RespondWith(JsonReply(Item(id, name, folder: true)));

    /// <summary>Runs the vendor action's operation in this host's runner; the action as it ended.</summary>
    public async Task<Crm.Integrations.Core.Actions.VendorAction> RunAsync(Guid actionId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        var operationId = (await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct)).OutboundOperationId;
        await host.Services.GetRequiredService<Crm.Integrations.Core.Actions.VendorActionRunner>().RunOneAsync(operationId, Ct);
        return await db.VendorActions.AsNoTracking().SingleAsync(a => a.Id == actionId, Ct);
    }

    public static object Item(string id, string name, bool folder, long size = 0, string modifiedBy = "Kari Nordmann") => folder
        ? new { id, name, webUrl = $"https://vardahei.sharepoint.com/Delte%20dokumenter/{Root}/{Uri.EscapeDataString(name)}", folder = new { childCount = 1 },
            lastModifiedDateTime = "2026-10-30T10:00:00Z", lastModifiedBy = new { user = new { displayName = modifiedBy } } }
        : new { id, name, size, webUrl = $"https://vardahei.sharepoint.com/Delte%20dokumenter/{Root}/{Uri.EscapeDataString(name)}",
            lastModifiedDateTime = "2026-10-29T10:00:00Z", lastModifiedBy = new { user = new { displayName = modifiedBy } } };

    public async Task<JsonElement> DocumentsAsync(Guid organizationId)
    {
        var response = await Client().GetAsync($"/api/v1/customers/organizations/{organizationId}/documents", Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        response.Headers.CacheControl!.NoStore.ShouldBeTrue("the answer names the person's files");
        return await response.ReadJsonAsync();
    }

    /// <summary>Links the organization to a folder on the mapping screen, as a person does.</summary>
    public async Task<Guid> LinkAsync(Guid organizationId, string folderId)
    {
        var response = await Client().PostAsJsonAsync("/api/v1/integrations/links",
            new { system = SharePointTypes.System, externalType = SharePointTypes.Folder, externalId = folderId, entityId = organizationId }, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return (await response.ReadJsonAsync()).GetProperty("id").GetGuid();
    }

    public async Task SyncFoldersAsync()
    {
        await using var scope = host.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<SharePointFolderSyncJob>().RunAsync(Ct);
    }

    public async Task<ExternalRecord?> RecordAsync(string folderId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().ExternalRecords.AsNoTracking()
            .SingleOrDefaultAsync(r => r.System == SharePointTypes.System && r.ExternalType == SharePointTypes.Folder && r.ExternalId == folderId, Ct);
    }

    /// <summary>The requests Graph received for a path, newest last.</summary>
    public IReadOnlyList<WireMock.IRequestMessage> Requests(string method, string pathPart) =>
        [.. graph.LogEntries.Select(e => e.RequestMessage!).Where(r => r.Method == method && r.Path.Contains(pathPart, StringComparison.Ordinal))];

    public async ValueTask DisposeAsync()
    {
        await host.DisposeAsync();
        graph.Stop();
        graph.Dispose();
    }

    /// <summary>A person without a delegated token: the development sign-in, or consent for the files not given.</summary>
    private sealed class NoPersonToken : IDelegatedTokenSource
    {
        public Task<string?> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken cancellationToken) => Task.FromResult<string?>(null);
    }
}
