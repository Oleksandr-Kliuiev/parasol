using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Actions;
using Crm.Integrations.Huntress;
using Crm.SharedKernel.Operations;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;
using static Crm.IntegrationTests.CustomerCreationCalls;
using static Crm.IntegrationTests.IntegrationTestHelpers;

namespace Crm.IntegrationTests;

/// <summary>
/// M43 on SQL Server: the "Connect services" wizard creates the customer's organization in Huntress (<c>organization.create</c>) on the
/// action path. The organization key is our key at Huntress: it is searched for before anything is created and again after an attempt
/// that got no clear answer (DEV-19); one found without an attempt of ours is never taken over; the link is made at once.
/// </summary>
[Collection(HuntressCollection.Name)]
public sealed class HuntressOrganizationCreationTests(CrmWebFactory factory)
{
    private const string Kind = HuntressActionKinds.OrganizationCreate;
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task An_organization_is_created_once_found_by_its_key_first_and_linked_at_once()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Fjordvarme");
        var services = await admin.ServicesAsync(organizationId);
        var huntress = services[HuntressTypes.System];
        huntress.GetProperty("kind").GetString().ShouldBe(Kind);
        huntress.GetProperty("link").ValueKind.ShouldBe(JsonValueKind.Null);
        huntress.GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null, "the wizard may create it");
        var key = huntress.GetProperty("defaults").GetProperty("key").GetString()!;
        key.ShouldStartWith("fjordvarme-", Case.Sensitive, "the key is proposed from the name");
        HuntressOrganizationKey.IsValid(key).ShouldBeTrue();

        var id = TestData.AteraId();
        host.List("/v1/organizations", "organizations", [], ("key", key));
        host.On("POST", "/v1/organizations").RespondWith(JsonReply(new { organization = Organization(id, name, key) }, 201));

        var preview = await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        preview.GetProperty("level").GetString().ShouldBe("Standard");
        preview.GetProperty("target").GetProperty("name").GetString().ShouldBe(name);
        preview.EffectCodes().ShouldBe(["VND_EFFECT_HUNTRESS_ORGANIZATION_CREATE", "VND_EFFECT_CUSTOMER_LINKED", "VND_EFFECT_HUNTRESS_AGENTS_LATER"]);

        var action = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));

        (action.Status, action.OutcomeCode, action.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED", id.ToString(CultureInfo.InvariantCulture)));
        host.Count("GET", "/v1/organizations").ShouldBe(1, "searched for the key first");
        host.Count("POST", "/v1/organizations").ShouldBe(1);
        var posted = host.Posted("/v1/organizations");
        (posted.GetProperty("name").GetString(), posted.GetProperty("key").GetString()).ShouldBe((name, key));
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System))!.ExternalId.ShouldBe(id.ToString(CultureInfo.InvariantCulture));
        var linked = (await admin.ServicesAsync(organizationId))[HuntressTypes.System].GetProperty("link");
        (linked.GetProperty("externalId").GetString(), linked.GetProperty("name").GetString()).ShouldBe((id.ToString(CultureInfo.InvariantCulture), name));

        var again = await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        again.BlockCode().ShouldBe("VND_ALREADY_CONNECTED");
    }

    [Fact]
    public async Task An_organization_with_the_key_that_parasoll_did_not_create_is_never_taken_over()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Bergfrukt");
        var key = $"bergfrukt-{Guid.NewGuid():N}"[..20];
        host.List("/v1/organizations", "organizations", [Organization(TestData.AteraId(), "Bergfrukt (made by hand)", key)], ("key", key));

        var action = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"));
        host.Count("POST", "/v1/organizations").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System)).ShouldBeNull("a person links it on the mapping screen");
    }

    [Fact]
    public async Task An_attempt_without_an_answer_is_settled_by_the_key_and_never_sent_twice()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Havtind");
        var key = $"havtind-{Guid.NewGuid():N}"[..18];
        var id = TestData.AteraId();
        // Huntress made the organization, but the answer to the POST was lost: the next attempt finds it by its key.
        var search = Request.Create().WithPath("/v1/organizations").UsingGet().WithParam("key", key);
        host.Huntress.Given(search).InScenario(key).RespondWith(Page([]));
        host.Huntress.Given(search).InScenario(key).WhenStateIs("made").RespondWith(Page([Organization(id, name, key)]));
        host.Huntress.Given(Request.Create().WithPath("/v1/organizations").UsingPost()).InScenario(key).WillSetStateTo("made")
            .RespondWith(Response.Create().WithStatusCode(502));

        var actionId = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        var first = await host.RunActionAsync(actionId);
        (first.Status, first.MayHaveSent).ShouldBe((VendorActionStatus.Queued, true));

        await DueNowAsync(host.Services, actionId);
        var second = await host.RunActionAsync(actionId);

        (second.Status, second.OutcomeCode, second.Reference).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED_EARLIER", id.ToString(CultureInfo.InvariantCulture)));
        host.Count("POST", "/v1/organizations").ShouldBe(1, "a repeat searches; it never creates a second organization");
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System))!.ExternalId.ShouldBe(id.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task An_attempt_without_an_answer_whose_organization_cannot_be_found_waits_for_a_person()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Lysfjell");
        var key = $"lysfjell-{Guid.NewGuid():N}"[..19];
        host.List("/v1/organizations", "organizations", [], ("key", key));
        host.On("POST", "/v1/organizations").RespondWith(Response.Create().WithStatusCode(502));

        var actionId = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        (await host.RunActionAsync(actionId)).Status.ShouldBe(VendorActionStatus.Queued);
        await DueNowAsync(host.Services, actionId);
        var settled = await host.RunActionAsync(actionId);

        (settled.Status, settled.OutcomeCode).ShouldBe((VendorActionStatus.Uncertain, "VND_CREATE_NOT_FOUND"));
        host.Count("POST", "/v1/organizations").ShouldBe(1);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System)).ShouldBeNull();
    }

    [Fact]
    public async Task An_unanswered_request_holds_back_the_next_until_a_person_settles_it_and_not_done_frees_the_way()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Snøtind");
        var key = $"snotind-{Guid.NewGuid():N}"[..18];
        var id = TestData.AteraId();
        host.List("/v1/organizations", "organizations", [], ("key", key));
        // The first POST gets no answer and Huntress made nothing; the next one is answered.
        var post = Request.Create().WithPath("/v1/organizations").UsingPost();
        host.Huntress.Given(post).InScenario(key).WillSetStateTo("answered").RespondWith(Response.Create().WithStatusCode(502));
        host.Huntress.Given(post).InScenario(key).WhenStateIs("answered").RespondWith(JsonReply(new { organization = Organization(id, name, key) }, 201));

        var firstId = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        await host.RunActionAsync(firstId);
        await DueNowAsync(host.Services, firstId);
        (await host.RunActionAsync(firstId)).OutcomeCode.ShouldBe("VND_CREATE_NOT_FOUND");

        // Until a person settles it, the wizard and the preview say so, whatever key is asked for.
        (await admin.ServicesAsync(organizationId))[HuntressTypes.System].GetProperty("block").GetString().ShouldBe("VND_EARLIER_ATTEMPT_OPEN");
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key })).BlockCode().ShouldBe("VND_EARLIER_ATTEMPT_OPEN");
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = key + "-2" })).BlockCode().ShouldBe("VND_EARLIER_ATTEMPT_OPEN");

        // A person checked in Huntress: nothing was made. The next request creates the organization.
        await SettleAsync(admin, firstId, "Failed", "Checked in Huntress: no organization with the key.");
        (await admin.ServicesAsync(organizationId))[HuntressTypes.System].GetProperty("block").ValueKind.ShouldBe(JsonValueKind.Null);
        var second = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));

        (second.Status, second.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED"));
        host.Count("POST", "/v1/organizations").ShouldBe(2);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System))!.ExternalId.ShouldBe(id.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task An_organization_removed_in_huntress_after_its_link_was_taken_off_is_created_again_once_a_person_says_so()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Furulund");
        var key = $"furulund-{Guid.NewGuid():N}"[..19];
        var id = TestData.AteraId();
        host.List("/v1/organizations", "organizations", [], ("key", key));
        host.On("POST", "/v1/organizations").RespondWith(JsonReply(new { organization = Organization(id, name, key) }, 201));
        (await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }))).OutcomeCode.ShouldBe("VND_CREATED");

        // The organization was removed in Huntress and its link taken off: the created attempt still says it may exist.
        var link = (await LinkAsync(host.Services, organizationId, HuntressTypes.System))!;
        (await admin.DeleteAsync($"/api/v1/integrations/links/{link.Id}", Ct)).IsSuccessStatusCode.ShouldBeTrue();
        var waiting = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        (await host.RunActionAsync(waiting)).OutcomeCode.ShouldBe("VND_CREATE_NOT_FOUND");

        // A person checked Huntress after it: nothing there. The attempts before that check count no more.
        await SettleAsync(admin, waiting, "Failed", "Checked in Huntress: the organization was removed.");
        var again = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));

        (again.Status, again.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED"));
        host.Count("POST", "/v1/organizations").ShouldBe(2);
    }

    [Fact]
    public async Task An_earlier_attempt_with_another_key_never_makes_an_organization_with_the_new_key_ours()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Varden");
        var (first, other) = ($"varden-{Guid.NewGuid():N}"[..17], $"varden-{Guid.NewGuid():N}"[..17]);
        host.List("/v1/organizations", "organizations", [], ("key", first));
        // Another technician made an organization with the second key for another customer; no read has stored it yet.
        host.List("/v1/organizations", "organizations", [Organization(TestData.AteraId(), "Varden Sør AS", other)], ("key", other));
        host.On("POST", "/v1/organizations").RespondWith(Response.Create().WithStatusCode(502));

        var firstId = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = first });
        await host.RunActionAsync(firstId);
        await DueNowAsync(host.Services, firstId);
        (await host.RunActionAsync(firstId)).OutcomeCode.ShouldBe("VND_CREATE_NOT_FOUND");
        // The person says the first one happened after all; the next request asks for the other key.
        await SettleAsync(admin, firstId, "Succeeded", "Made in Huntress under the first key, it seems.");

        var second = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = other }));

        (second.Status, second.OutcomeCode).ShouldBe((VendorActionStatus.Rejected, "VND_EXISTS_AT_VENDOR"), "an attempt with another key made nothing with this one");
        host.Count("POST", "/v1/organizations").ShouldBe(1);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System)).ShouldBeNull();
    }

    [Fact]
    public async Task A_create_that_cannot_be_read_back_stays_open_and_the_next_attempt_links_it()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Bølgen");
        var key = $"bolgen-{Guid.NewGuid():N}"[..17];
        var id = TestData.AteraId();
        // Huntress answers the POST without the organization, and the read that follows is refused once.
        var search = Request.Create().WithPath("/v1/organizations").UsingGet().WithParam("key", key);
        host.Huntress.Given(search).InScenario(key).RespondWith(Page([]));
        host.Huntress.Given(Request.Create().WithPath("/v1/organizations").UsingPost()).InScenario(key).WillSetStateTo("made")
            .RespondWith(JsonReply(new { }, 201));
        host.Huntress.Given(search).InScenario(key).WhenStateIs("made").WillSetStateTo("readable").RespondWith(Response.Create().WithStatusCode(404));
        host.Huntress.Given(search).InScenario(key).WhenStateIs("readable").RespondWith(Page([Organization(id, name, key)]));

        var actionId = await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        var first = await host.RunActionAsync(actionId);
        (first.Status, first.MayHaveSent).ShouldBe((VendorActionStatus.Queued, true), "a 404 after the create is not a refusal of it");
        await DueNowAsync(host.Services, actionId);
        var second = await host.RunActionAsync(actionId);

        (second.Status, second.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED_EARLIER"));
        host.Count("POST", "/v1/organizations").ShouldBe(1);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System))!.ExternalId.ShouldBe(id.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task An_organization_named_like_the_customer_that_nobody_linked_is_offered_for_linking_instead()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, name) = await NewCustomerAsync(admin, "Skogly");
        // Someone made it in Huntress's console under a key of their own; the last read stored it.
        host.List("/v1/organizations", "organizations", [Organization(TestData.AteraId(), name.ToUpperInvariant(), "skogly-by-hand")]);
        await host.RunJobAsync<HuntressOrganizationSyncJob>(job => job.RunAsync(Ct));

        var huntress = (await admin.ServicesAsync(organizationId))[HuntressTypes.System];
        (huntress.GetProperty("block").GetString(), huntress.GetProperty("existing").GetString()).ShouldBe(("VND_EXISTS_AT_VENDOR", name.ToUpperInvariant()));
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = $"skogly-{Guid.NewGuid():N}"[..17] }))
            .BlockCode().ShouldBe("VND_EXISTS_AT_VENDOR");
    }

    [Fact]
    public async Task A_refusal_creates_nothing_and_a_later_request_may_try_again()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Snøkrystall");
        var key = $"snokrystall-{Guid.NewGuid():N}"[..20];
        host.List("/v1/organizations", "organizations", [], ("key", key));
        host.On("POST", "/v1/organizations").RespondWith(JsonReply(new { errors = new[] { "Invalid creation parameters." } }, 422));

        var refused = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));
        (refused.Status, refused.OutcomeCode).ShouldBe((VendorActionStatus.Failed, "VND_VENDOR_REFUSED"));

        await using var scope = host.Services.CreateAsyncScope();
        var journal = await scope.ServiceProvider.GetRequiredService<IExternalEffectJournal>()
            .ForEntityAsync("Organization", organizationId, Ct);
        ExternalEffects.MayExist(journal.Where(e => e.Kind == HuntressCreateOrganizationAction.OrganizationEffect)).ShouldBeFalse("the refusal closed the attempt");

        host.On("POST", "/v1/organizations").RespondWith(JsonReply(new { organization = Organization(TestData.AteraId(), "Snøkrystall", key) }, 201));
        var retried = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));
        (retried.Status, retried.OutcomeCode).ShouldBe((VendorActionStatus.Succeeded, "VND_CREATED"));
    }

    [Fact]
    public async Task Test_mode_searches_huntress_and_creates_nothing()
    {
        await using var host = HuntressHost.Start(factory, write: false, dryRun: true, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Prøvekunde");
        var key = $"provekunde-{Guid.NewGuid():N}"[..20];
        host.List("/v1/organizations", "organizations", [], ("key", key));

        var preview = await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key });
        preview.GetProperty("simulated").GetBoolean().ShouldBeTrue();
        var action = await host.RunActionAsync(await admin.AskCreateAsync(HuntressTypes.System, Kind, organizationId, new { key }));

        (action.Status, action.OutcomeCode).ShouldBe((VendorActionStatus.Simulated, "VND_DRY_RUN"));
        host.Count("POST", "/v1/organizations").ShouldBe(0);
        (await LinkAsync(host.Services, organizationId, HuntressTypes.System)).ShouldBeNull();
    }

    [Fact]
    public async Task The_preview_refuses_a_bad_key_and_a_key_the_last_read_already_saw()
    {
        await using var host = HuntressHost.Start(factory, kinds: [Kind]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Kystlys");

        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = "Not a key!" })).BlockCode().ShouldBe("VND_KEY_INVALID");
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { })).BlockCode().ShouldBe("VND_KEY_INVALID");

        // The hourly read of Huntress's organizations saw one with this key that nobody has linked yet.
        var key = $"kystlys-{Guid.NewGuid():N}"[..18];
        host.List("/v1/organizations", "organizations", [Organization(TestData.AteraId(), "Kystlys (Huntress)", key)]);
        await host.RunJobAsync<HuntressOrganizationSyncJob>(job => job.RunAsync(Ct));
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key })).BlockCode().ShouldBe("VND_EXISTS_AT_VENDOR");
    }

    [Fact]
    public async Task An_allow_list_lets_through_only_the_customer_it_names_by_its_crm_id()
    {
        var factoryClient = factory.ClientAs(CrmRoles.Admin);
        var (allowedId, _) = await NewCustomerAsync(factoryClient, "Tillatt");
        var (otherId, _) = await NewCustomerAsync(factoryClient, "Ikketillatt");
        await using var host = HuntressHost.Start(factory, kinds: [Kind], allowed: ["99999999", allowedId.ToString("D")]);
        var admin = host.Client();

        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, allowedId, new { key = "tillatt" })).BlockCode().ShouldBeNull();
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, otherId, new { key = "ikketillatt" })).BlockCode().ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
        (await admin.ServicesAsync(otherId))[HuntressTypes.System].GetProperty("block").GetString().ShouldBe("VND_CUSTOMER_NOT_ALLOWED");
    }

    [Fact]
    public async Task Without_the_kind_switched_on_the_wizard_says_so_and_the_preview_refuses()
    {
        await using var host = HuntressHost.Start(factory, kinds: [HuntressActionKinds.Isolate]);
        var admin = host.Client();
        var (organizationId, _) = await NewCustomerAsync(admin, "Avslått");

        (await admin.ServicesAsync(organizationId))[HuntressTypes.System].GetProperty("block").GetString().ShouldBe("VND_KIND_DISABLED");
        (await admin.PreviewCreateAsync(HuntressTypes.System, Kind, organizationId, new { key = "avslatt" })).BlockCode().ShouldBe("VND_KIND_DISABLED");
    }

    /// <summary>A person's word on an uncertain action, as the action log sends it.</summary>
    private static async Task SettleAsync(HttpClient admin, Guid actionId, string outcome, string reason)
    {
        var action = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/actions/{actionId}", Ct);
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/actions/{actionId}/settle") { Content = JsonContent.Create(new { outcome, reason }) };
        request.Headers.TryAddWithoutValidation("If-Match", action.GetProperty("etag").GetString());
        var response = await admin.SendAsync(request, Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
    }

    private static async Task<(Guid Id, string Name)> NewCustomerAsync(HttpClient admin, string prefix)
    {
        var name = $"{prefix} {Guid.NewGuid():N}"[..(prefix.Length + 7)] + " AS";
        return (await admin.CreateOrganizationAsync(new { name, status = "Customer" }), name);
    }

    private static Dictionary<string, object?> Organization(long id, string name, string key) => new()
    {
        ["id"] = id, ["name"] = name, ["key"] = key, ["account_id"] = 1, ["agents_count"] = 0, ["incident_reports_count"] = 0,
        ["created_at"] = "2026-10-23T08:00:00Z", ["updated_at"] = "2026-10-23T08:00:00Z",
    };

    private static IResponseBuilder Page(IEnumerable<object> organizations) => JsonReply(new Dictionary<string, object?>
    {
        ["organizations"] = organizations.ToList(),
        ["pagination"] = new Dictionary<string, object?> { ["next_page_token"] = null, ["next_page_url"] = null },
    });
}
