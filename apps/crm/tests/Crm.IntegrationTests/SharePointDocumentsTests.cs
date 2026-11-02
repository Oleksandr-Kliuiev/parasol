using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.MicrosoftGraph;
using Crm.SharedKernel.Domain;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.Matchers;
using WireMock.RequestBuilders;
using static Crm.IntegrationTests.CustomerCreationCalls;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>The SharePoint tests run one after another: the mapping screen's auto-link reads every unlinked folder of the database.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class SharePointCollection
{
    public const string Name = "sharepoint";
}

/// <summary>
/// M47 on SQL Server: the customer's folder in SharePoint is read with the person's own token and every way the read ends is a state of
/// its own; the folders of the root folder come to the mapping screen, where the old ones are only suggested; a folder is created on
/// request on the M43 path and never beside one a person made; and only a folder with the CRM's own name follows a rename.
/// </summary>
[Collection(SharePointCollection.Name)]
public sealed class SharePointDocumentsTests(CrmWebFactory factory)
{
    private const string Kind = SharePointActionKinds.FolderCreate;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_tab_reads_the_folder_with_the_persons_own_token_and_says_when_there_is_more()
    {
        await using var host = SharePointHost.Start(factory);
        var marker = Marker();
        var organizationId = await host.Client().CreateOrganizationAsync(new { name = $"{marker} Dokument AS", status = "Customer" });
        var folderId = $"f-{marker}";
        var linkId = await host.LinkAsync(organizationId, folderId);
        host.Folder(folderId, $"{marker} Dokument", more: true,
            SharePointHost.Item($"a-{marker}", "Avtale.pdf", folder: false, size: 20480, modifiedBy: "Ola Nordmann"),
            SharePointHost.Item($"t-{marker}", "Tilbod", folder: true));

        var documents = await host.DocumentsAsync(organizationId);

        (documents.GetProperty("available").GetBoolean(), documents.GetProperty("state").GetString()).ShouldBe((true, "Ready"));
        documents.GetProperty("linkId").GetGuid().ShouldBe(linkId);
        documents.GetProperty("folder").GetProperty("name").GetString().ShouldBe($"{marker} Dokument");
        documents.GetProperty("more").GetBoolean().ShouldBeTrue("the folder has a next page, so the card says there is more");
        var items = documents.GetProperty("items").EnumerateArray().ToList();
        items.Select(i => i.GetProperty("name").GetString()).ShouldBe(["Tilbod", "Avtale.pdf"], "folders first");
        items[1].GetProperty("size").GetInt64().ShouldBe(20480);
        items[1].GetProperty("modifiedBy").GetString().ShouldBe("Ola Nordmann");
        foreach (var request in host.Requests("GET", folderId))
        {
            request.Headers!["Authorization"].ShouldBe(["Bearer test-delegated-token"], "the person's token, never the application's");
        }
    }

    [Fact]
    public async Task A_folder_that_cannot_be_read_is_never_shown_as_missing()
    {
        await using var host = SharePointHost.Start(factory);
        var admin = host.Client();
        var marker = Marker();

        async Task<string?> StateAsync(HttpStatusCode? answer)
        {
            var organizationId = await admin.CreateOrganizationAsync(new { name = $"{marker} {answer} AS", status = "Customer" });
            if (answer is { } status)
            {
                var folderId = $"x-{marker}-{(int)status}";
                await host.LinkAsync(organizationId, folderId);
                host.Fails(folderId, status);
            }

            return (await host.DocumentsAsync(organizationId)).GetProperty("state").GetString();
        }

        (await StateAsync(null)).ShouldBe("NoFolder");
        (await StateAsync(HttpStatusCode.NotFound)).ShouldBe("Gone", "a folder the CRM does not list either");
        (await StateAsync(HttpStatusCode.Forbidden)).ShouldBe("NoAccess");
        (await StateAsync(HttpStatusCode.BadRequest)).ShouldBe("Unavailable");
    }

    [Fact]
    public async Task A_folder_the_crm_still_lists_is_out_of_the_persons_reach_and_gone_only_once_the_listing_misses_it()
    {
        await using var host = SharePointHost.Start(factory);
        var marker = Marker();
        var folderId = $"h-{marker}";
        host.RootLists(SharePointHost.Item(folderId, $"{marker} Skjult AS (999888777)", folder: true));
        await host.SyncFoldersAsync();
        var organizationId = await host.Client().CreateOrganizationAsync(new { name = $"{marker} Skjult AS", status = "Customer" });
        await host.LinkAsync(organizationId, folderId);
        host.Fails(folderId, HttpStatusCode.NotFound);

        (await host.DocumentsAsync(organizationId)).GetProperty("state").GetString()
            .ShouldBe("NoAccess", "Graph hides a folder the person may not open behind a 404; the CRM still lists it");

        host.RootLists();
        await host.SyncFoldersAsync();

        (await host.DocumentsAsync(organizationId)).GetProperty("state").GetString().ShouldBe("Gone");
    }

    [Fact]
    public async Task Without_the_persons_token_the_tab_says_sharepoint_is_not_connected()
    {
        await using var host = SharePointHost.Start(factory, connected: false);
        var marker = Marker();
        var organizationId = await host.Client().CreateOrganizationAsync(new { name = $"{marker} Utan AS", status = "Customer" });
        await host.LinkAsync(organizationId, $"n-{marker}");

        var documents = await host.DocumentsAsync(organizationId);

        documents.GetProperty("state").GetString().ShouldBe("NotConnected");
        host.Requests("GET", $"n-{marker}").ShouldBeEmpty("nothing is asked of SharePoint without the person's token");
    }

    [Fact]
    public async Task The_mapping_screen_lists_the_folders_of_the_root_folder_and_only_suggests_the_old_ones()
    {
        await using var host = SharePointHost.Start(factory);
        var admin = host.Client();
        var marker = Marker();
        var orgNumber = TestData.OrgNumber();
        var hotelId = await admin.CreateOrganizationAsync(new { name = $"{marker} Hotel AS", status = "Customer" });
        var fjordId = await admin.CreateOrganizationAsync(new { name = $"{marker} Fjord AS", status = "Customer", orgNumber });
        host.RootLists(
            SharePointHost.Item($"old-{marker}", $"{marker} Hotel", folder: true),
            SharePointHost.Item($"own-{marker}", $"{marker} Fjord AS ({orgNumber})", folder: true),
            SharePointHost.Item($"file-{marker}", $"{marker} readme.txt", folder: false, size: 12));

        await host.SyncFoldersAsync();

        var page = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/integrations/records?system=graph&type=Folder&search={marker}", Ct);
        var records = page.GetProperty("items").EnumerateArray().ToDictionary(r => r.GetProperty("externalId").GetString()!);
        records.Keys.ShouldBe([$"old-{marker}", $"own-{marker}"], ignoreOrder: true, "the file beside the folders is not a customer");
        var oldSuggestion = records[$"old-{marker}"].GetProperty("suggestions").EnumerateArray().ShouldHaveSingleItem();
        oldSuggestion.GetProperty("entityId").GetGuid().ShouldBe(hotelId);
        oldSuggestion.GetProperty("reasons").EnumerateArray().Select(r => r.GetString()).ShouldBe(["SameName"]);
        records[$"own-{marker}"].GetProperty("orgNumber").GetString().ShouldBe(orgNumber);

        // Only the org number links by itself; the old folder waits for a person.
        (await admin.PostAsync("/api/v1/integrations/records/graph/Folder/auto-link", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
        var linked = await LinkAsync(host.Services, fjordId, SharePointTypes.System);
        (linked!.ExternalId, linked.Method).ShouldBe(($"own-{marker}", LinkMethod.Automatic));
        (await LinkAsync(host.Services, hotelId, SharePointTypes.System)).ShouldBeNull();

        // A folder is linked, never turned into an organization.
        var import = await admin.PostAsync($"/api/v1/integrations/records/graph/Folder/old-{marker}/import", null, Ct);
        import.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        (await import.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("INT_NOT_IMPORTABLE");
        var status = (await admin.GetFromJsonAsync<JsonElement>("/api/v1/integrations/status", Ct)).EnumerateArray()
            .Single(s => s.GetProperty("system").GetString() == SharePointTypes.System);
        status.GetProperty("recordTypes").EnumerateArray().Select(t => t.GetString()).ShouldBe([SharePointTypes.Folder]);
        status.GetProperty("importableTypes").GetArrayLength().ShouldBe(0);

        // A folder SharePoint no longer lists is gone after the next complete read.
        host.RootLists(SharePointHost.Item($"own-{marker}", $"{marker} Fjord AS ({orgNumber})", folder: true));
        await host.SyncFoldersAsync();
        (await host.RecordAsync($"old-{marker}"))!.IsGone.ShouldBeTrue();
        (await host.RecordAsync($"own-{marker}"))!.IsGone.ShouldBeFalse();
    }

    [Fact]
    public async Task A_folder_is_created_in_the_root_folder_and_linked_when_none_of_the_customer_is_there()
    {
        await using var host = SharePointHost.Start(factory);
        var admin = host.Client();
        var marker = Marker();
        var orgNumber = TestData.OrgNumber();
        var name = $"{marker} Ny AS";
        var organizationId = await admin.CreateOrganizationAsync(new { name, status = "Customer", orgNumber });
        var folderName = $"{name} ({orgNumber})";
        var folderId = $"new-{marker}";
        host.Graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{SharePointHost.Drive}/root:/{SharePointHost.Root}:/children").UsingPost()
                .WithBody(new WildcardMatcher($"*{marker}*")))
            .RespondWith(JsonReply(SharePointHost.Item(folderId, folderName, folder: true), 201));

        var service = (await admin.ServicesAsync(organizationId))[SharePointTypes.System];
        service.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null);
        service.GetProperty("defaults").GetProperty("name").GetString().ShouldBe(folderName);
        service.GetProperty("defaults").GetProperty("root").GetString().ShouldBe(SharePointHost.Root);
        var preview = await admin.PreviewCreateAsync(SharePointTypes.System, Kind, organizationId);
        preview.EffectCodes().ShouldBe(["VND_EFFECT_SHAREPOINT_FOLDER_CREATE", "VND_EFFECT_CUSTOMER_LINKED"]);
        preview.GetProperty("effects")[0].GetProperty("values").GetProperty("name").GetString().ShouldBe(folderName);

        var action = await host.RunAsync(await admin.AskCreateAsync(SharePointTypes.System, Kind, organizationId));

        (action.Status, action.OutcomeCode, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED", folderId));
        var posted = JsonDocument.Parse(host.Requests("POST", $"root:/{SharePointHost.Root}:/children").Single(r => r.Body!.Contains(marker, StringComparison.Ordinal)).Body!)
            .RootElement;
        (posted.GetProperty("name").GetString(), posted.GetProperty("@microsoft.graph.conflictBehavior").GetString()).ShouldBe((folderName, "fail"));
        var link = await LinkAsync(host.Services, organizationId, SharePointTypes.System);
        (link!.ExternalId, link.Method).ShouldBe((folderId, LinkMethod.Exported));
        (await host.RecordAsync(folderId))!.OrgNumber.ShouldBe(orgNumber);

        host.Folder(folderId, folderName);
        (await host.DocumentsAsync(organizationId)).GetProperty("state").GetString().ShouldBe("Ready");
    }

    [Fact]
    public async Task A_folder_a_person_made_for_the_customer_is_never_made_a_second_time()
    {
        await using var host = SharePointHost.Start(factory);
        var admin = host.Client();
        var marker = Marker();

        // The mapping screen has read a folder under the customer's plain name: the preview sends the person to link it.
        var savedId = await admin.CreateOrganizationAsync(new { name = $"{marker} Gammel AS", status = "Customer", orgNumber = TestData.OrgNumber() });
        host.RootLists(SharePointHost.Item($"old-{marker}", $"{marker} Gammel", folder: true));
        await host.SyncFoldersAsync();
        (await admin.PreviewCreateAsync(SharePointTypes.System, Kind, savedId)).BlockCode().ShouldBe("VND_EXISTS_AT_VENDOR");
        (await admin.ServicesAsync(savedId))[SharePointTypes.System].GetProperty("block").GetString().ShouldBeNull(
            "the wizard compares exact names; the preview it leads to blocks");

        // One made since the last read is found at the attempt, which sends nothing.
        var liveId = await admin.CreateOrganizationAsync(new { name = $"{marker} Kopi AS", status = "Customer", orgNumber = TestData.OrgNumber() });
        host.InRoot($"live-{marker}", $"{marker} Kopi");
        var action = await host.RunAsync(await admin.AskCreateAsync(SharePointTypes.System, Kind, liveId));
        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"));
        host.Requests("POST", "/children").Where(r => r.Body!.Contains(marker, StringComparison.Ordinal)).ShouldBeEmpty();
        (await LinkAsync(host.Services, liveId, SharePointTypes.System)).ShouldBeNull();

        // In test mode SharePoint is read and nothing is made.
        await using var test = SharePointHost.Start(factory, dryRun: true);
        var dryId = await test.Client().CreateOrganizationAsync(new { name = $"{marker} Prove AS", status = "Customer", orgNumber = TestData.OrgNumber() });
        var simulated = await test.RunAsync(await test.Client().AskCreateAsync(SharePointTypes.System, Kind, dryId));
        (simulated.Status, simulated.OutcomeCode).ShouldBe((VendorActionStatus.Simulated, "VND_DRY_RUN"));
        test.Requests("POST", "/children").ShouldBeEmpty();
    }

    [Fact]
    public async Task Only_a_folder_with_the_crms_own_name_follows_a_rename()
    {
        await using var host = SharePointHost.Start(factory);
        var admin = host.Client();
        var marker = Marker();
        var orgNumber = TestData.OrgNumber();
        var ownId = await admin.CreateOrganizationAsync(new { name = $"{marker} Gamalt Namn AS", status = "Customer", orgNumber });
        var manualId = await admin.CreateOrganizationAsync(new { name = $"{marker} Manuell AS", status = "Customer", orgNumber = TestData.OrgNumber() });
        await host.LinkAsync(ownId, $"own-{marker}");
        await host.LinkAsync(manualId, $"man-{marker}");
        host.Folder($"own-{marker}", $"{marker} Gamalt Namn AS ({orgNumber})");
        host.Folder($"man-{marker}", $"{marker} Manuell");
        host.Graph.Given(Request.Create().WithPath($"/graph/v1.0/drives/{SharePointHost.Drive}/items/own-{marker}").UsingPatch())
            .RespondWith(JsonReply(SharePointHost.Item($"own-{marker}", $"{marker} Nytt Namn AS ({orgNumber})", folder: true)));
        await RenameAsync(admin, ownId, $"{marker} Nytt Namn AS");
        await RenameAsync(admin, manualId, $"{marker} Manuell Ny AS");

        // The handler queues a rename for a linked folder while writing is on; the worker decides by the folder's name.
        await using (var scope = host.Services.CreateAsyncScope())
        {
            var handler = scope.ServiceProvider.GetServices<IDomainEventHandler<OrganizationUpdated>>().OfType<OrganizationFolderHandler>().Single();
            await handler.HandleAsync(new OrganizationUpdated(ownId), Ct);
            await handler.HandleAsync(new OrganizationUpdated(manualId), Ct);
        }

        var operations = await OperationsAsync(host.Services, ownId, manualId);
        operations.Count.ShouldBe(2);
        var outbound = host.Services.GetRequiredService<OutboundProcessorJob>();
        foreach (var operation in operations)
        {
            (await outbound.ExecuteOneAsync(operation.Id, Ct)).ShouldBeTrue();
        }

        var patch = host.Requests("PATCH", $"items/own-{marker}").ShouldHaveSingleItem();
        JsonDocument.Parse(patch.Body!).RootElement.GetProperty("name").GetString().ShouldBe($"{marker} Nytt Namn AS ({orgNumber})");
        host.Requests("PATCH", $"items/man-{marker}").ShouldBeEmpty("a folder a person named keeps its name");
        var done = await OperationsAsync(host.Services, ownId, manualId);
        done.ShouldAllBe(o => o.Status == OutboundStatus.Succeeded);
        done.Single(o => o.EntityId == manualId).Result.ShouldBe("The folder carries a name a person chose; it keeps it.");
    }

    private static string Marker() => $"S{Guid.NewGuid():N}"[..9];

    private static async Task RenameAsync(HttpClient admin, Guid organizationId, string name)
    {
        var read = await admin.GetAsync($"/api/v1/customers/organizations/{organizationId}", Ct);
        var current = await read.Content.ReadFromJsonAsync<JsonElement>(Ct);
        using var edit = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/customers/organizations/{organizationId}")
        {
            Content = JsonContent.Create(new
            {
                name, orgNumber = current.GetProperty("orgNumber").GetString(), status = "Customer",
                email = current.GetProperty("email").GetString(), phone = current.GetProperty("phone").GetString(),
                invoiceEmail = current.GetProperty("invoiceEmail").GetString(), ehfEnabled = current.GetProperty("ehfEnabled").GetBoolean(),
            }),
        };
        edit.Headers.IfMatch.ParseAdd(read.Headers.ETag!.Tag);
        (await admin.SendAsync(edit, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    private static async Task<List<OutboundOperation>> OperationsAsync(IServiceProvider services, params Guid[] organizationIds)
    {
        await using var scope = services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
            .Where(o => o.System == SharePointTypes.System && o.Operation == SharePointFolderRename.OperationName && organizationIds.Contains(o.EntityId))
            .ToListAsync(Ct);
    }
}
