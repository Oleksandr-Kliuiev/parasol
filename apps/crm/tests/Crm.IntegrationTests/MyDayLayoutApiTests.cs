using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Crm.Authorization;

namespace Crm.IntegrationTests;

/// <summary>
/// M38: My day follows a layout each person chooses and the CRM keeps. It needs only a sign-in — the choice is the person's
/// own — and has its own request, so saving it can never reset the chosen language the way /me/preferences would.
/// </summary>
public sealed class MyDayLayoutApiTests(CrmWebFactory factory)
{
    private const string Layout = "/api/v1/identity/me/my-day-layout";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<JsonElement> MeAsync(HttpClient client) => await client.GetFromJsonAsync<JsonElement>("/bff/user", Ct);

    [Fact]
    public async Task The_choice_is_saved_for_the_signed_in_person_alone_and_leaves_the_language_as_it_was()
    {
        var key = "layout-" + Guid.NewGuid().ToString("N");
        // The role with the fewest permissions: choosing a layout needs none.
        var me = factory.ClientAs(CrmRoles.ReadOnly, key);
        var colleague = factory.ClientAs(CrmRoles.ReadOnly, key + "-colleague");
        (await MeAsync(me)).GetProperty("myDayLayout").ValueKind.ShouldBe(JsonValueKind.Null);
        (await me.PutAsJsonAsync("/api/v1/identity/me/preferences", new { language = "nn" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        (await me.PutAsJsonAsync(Layout, new { layout = "finance" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        var user = await MeAsync(me);
        user.GetProperty("myDayLayout").GetString().ShouldBe("finance");
        user.GetProperty("preferredLanguage").GetString().ShouldBe("nn");
        (await MeAsync(colleague)).GetProperty("myDayLayout").ValueKind.ShouldBe(JsonValueKind.Null);

        (await me.PutAsJsonAsync(Layout, new { layout = "lead" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await MeAsync(me)).GetProperty("myDayLayout").GetString().ShouldBe("lead");
        // Changing the language afterwards keeps the layout as well.
        (await me.PutAsJsonAsync("/api/v1/identity/me/preferences", new { language = "en" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        (await MeAsync(me)).GetProperty("myDayLayout").GetString().ShouldBe("lead");
    }

    [Theory]
    [InlineData("""{"layout":"admin"}""")]
    [InlineData("""{"layout":"Finance"}""")]
    [InlineData("""{"layout":""}""")]
    [InlineData("""{"layout":null}""")]
    [InlineData("{}")]
    public async Task Anything_but_the_three_layouts_is_refused_and_keeps_the_saved_choice(string body)
    {
        var me = factory.ClientAs(CrmRoles.Technician, "layout-refused-" + Guid.NewGuid().ToString("N"));
        (await me.PutAsJsonAsync(Layout, new { layout = "work" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.NoContent);

        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        var response = await me.PutAsync(Layout, content, Ct);

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await response.Content.ReadAsStringAsync(Ct)).ShouldContain("Supported layouts: work, lead, finance.");
        (await MeAsync(me)).GetProperty("myDayLayout").GetString().ShouldBe("work");
    }

    [Fact]
    public async Task A_request_another_site_could_send_saves_nothing_and_a_signed_out_one_is_refused()
    {
        var key = "layout-csrf-" + Guid.NewGuid().ToString("N");
        var me = factory.ClientAs(CrmRoles.Sales, key);
        (await MeAsync(me)).GetProperty("myDayLayout").ValueKind.ShouldBe(JsonValueKind.Null);

        var withoutHeader = factory.ClientAs(CrmRoles.Sales, key, csrf: false);
        (await withoutHeader.PutAsJsonAsync(Layout, new { layout = "finance" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        (await MeAsync(me)).GetProperty("myDayLayout").ValueKind.ShouldBe(JsonValueKind.Null);

        var anonymous = factory.AnonymousClient();
        anonymous.DefaultRequestHeaders.Add("X-CSRF", "1");
        (await anonymous.PutAsJsonAsync(Layout, new { layout = "finance" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }
}
