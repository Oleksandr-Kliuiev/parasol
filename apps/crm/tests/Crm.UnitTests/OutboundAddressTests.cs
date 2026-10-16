using System.Net;
using System.Text;
using Azure.Core;
using Crm.Integrations.MicrosoftGraph;
using Crm.SharedKernel.Text;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>F-G5-12 and F-G4-16: where the application sends its tokens and secrets, and which addresses it follows.</summary>
public class OutboundAddressTests
{
    private static readonly Uri Graph = new("https://graph.example/v1.0/");

    private sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(answer(request));
        }
    }

    private sealed class FakeCredential : TokenCredential
    {
        public int Issued { get; private set; }

        public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken) => Token();

        public override ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken) => new(Token());

        private AccessToken Token()
        {
            Issued++;
            return new AccessToken("secret-token", DateTimeOffset.UtcNow.AddHours(1));
        }
    }

    private static HttpResponseMessage Json(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task A_next_link_on_another_host_is_not_followed()
    {
        var stub = new Stub(_ => Json("""{"value":[],"@odata.nextLink":"https://evil.example/v1.0/users/delta?x=1"}"""));
        var source = new GraphUserSource(new HttpClient(stub) { BaseAddress = Graph });

        await Should.ThrowAsync<InvalidOperationException>(() => source.GetUserChangesAsync(null, CancellationToken.None));
        stub.Requests.Count.ShouldBe(1);
        stub.Requests.ShouldAllBe(r => r.Host == "graph.example");
    }

    [Fact]
    public async Task A_next_link_on_the_graph_host_is_followed_and_a_foreign_delta_link_is_refused()
    {
        var page = 0;
        var stub = new Stub(_ => ++page == 1
            ? Json("""{"value":[],"@odata.nextLink":"https://graph.example/v1.0/users/delta?$skiptoken=abc"}""")
            : Json("""{"value":[],"@odata.deltaLink":"https://graph.example/v1.0/users/delta?$deltatoken=xyz"}"""));
        var result = await new GraphUserSource(new HttpClient(stub) { BaseAddress = Graph }).GetUserChangesAsync(null, CancellationToken.None);
        result.DeltaLink.ShouldEndWith("deltatoken=xyz");
        stub.Requests.Count.ShouldBe(2);

        var foreign = new Stub(_ => Json("""{"value":[],"@odata.deltaLink":"https://evil.example/d"}"""));
        await Should.ThrowAsync<InvalidOperationException>(
            () => new GraphUserSource(new HttpClient(foreign) { BaseAddress = Graph }).GetUserChangesAsync(null, CancellationToken.None));

        // A stored cursor that points elsewhere is treated as expired (full re-sync) and nothing is requested with it.
        var untouched = new Stub(_ => Json("""{"value":[],"@odata.deltaLink":"https://graph.example/v1.0/users/delta?t=1"}"""));
        await Should.ThrowAsync<DeltaTokenExpiredException>(
            () => new GraphUserSource(new HttpClient(untouched) { BaseAddress = Graph }).GetUserChangesAsync("https://evil.example/d", CancellationToken.None));
        untouched.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task The_graph_token_is_never_attached_to_a_request_for_another_host()
    {
        var credential = new FakeCredential();
        var options = Options.Create(new GraphOptions { BaseUrl = Graph });
        var inner = new Stub(_ => new HttpResponseMessage(HttpStatusCode.OK));
        using var client = new HttpClient(new GraphAuthenticationHandlerAccessor(credential, options, inner).Handler);

        (await client.GetAsync("https://graph.example/v1.0/users")).StatusCode.ShouldBe(HttpStatusCode.OK);
        credential.Issued.ShouldBe(1);

        await Should.ThrowAsync<InvalidOperationException>(() => client.GetAsync("https://evil.example/steal"));
        await Should.ThrowAsync<InvalidOperationException>(() => client.GetAsync("http://graph.example/v1.0/users"));
        credential.Issued.ShouldBe(1);
        inner.Requests.Count.ShouldBe(1);
    }

    // The handler is internal to the assembly; building it through reflection-free construction keeps the test honest.
    private sealed class GraphAuthenticationHandlerAccessor
    {
        public GraphAuthenticationHandlerAccessor(TokenCredential credential, IOptions<GraphOptions> options, HttpMessageHandler inner) =>
            Handler = new GraphAuthenticationHandler(credential, options) { InnerHandler = inner };

        public DelegatingHandler Handler { get; }
    }

    [Theory]
    [InlineData("https://graph.microsoft.com/v1.0/", true)]
    [InlineData("http://graph.microsoft.com/v1.0/", false)]
    [InlineData("http://localhost:5000/", true)]
    [InlineData("http://127.0.0.1:9999/api", true)]
    [InlineData("ftp://x.example/", false)]
    [InlineData("https://user:pw@host.example/", false)]
    public void Only_https_is_accepted_for_an_outbound_address_except_for_a_local_stub(string url, bool expected) =>
        WebUrl.IsSecureEndpoint(new Uri(url)).ShouldBe(expected);

    [Fact]
    public void A_teams_webhook_must_be_https_on_an_allowed_host_and_the_error_does_not_echo_the_url()
    {
        var good = new GraphOptions();
        good.Teams.Channels["Sales"] = "https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual?sig=SECRET";
        good.IsValid(out _).ShouldBeTrue();

        foreach (var bad in new[]
        {
            "http://prod-12.westeurope.logic.azure.com/workflows/abc?sig=SECRET",
            "https://evil.example/workflows/abc?sig=SECRET",
            "https://logic.azure.com.evil.example/x?sig=SECRET",
            "not a url SECRET",
        })
        {
            var options = new GraphOptions();
            options.Teams.Channels["Sales"] = bad;
            options.IsValid(out var problem).ShouldBeFalse(bad);
            problem.ShouldNotContain("SECRET");
            problem.ShouldContain("Sales");
        }

        new GraphOptions { BaseUrl = new Uri("http://graph.microsoft.com/v1.0/") }.IsValid(out _).ShouldBeFalse();
    }

    [Theory]
    [InlineData("https://havbris.no", "https://havbris.no")]
    [InlineData("havbris.no", "https://havbris.no")]
    [InlineData("HTTP://havbris.no/a", "HTTP://havbris.no/a")]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("javascript://x%0Aalert(1)", null)]
    [InlineData("data:text/html,<script>alert(1)</script>", null)]
    [InlineData("vbscript:msgbox(1)", null)]
    [InlineData("ftp://havbris.no", null)]
    [InlineData("https://hav\tbris.no", null)]
    [InlineData("https://", null)]
    [InlineData("   ", null)]
    public void A_website_is_kept_only_as_an_http_or_https_address(string input, string? expected) =>
        WebUrl.Normalize(input).ShouldBe(expected);
}

/// <summary>F-G1-13: what may reach a mailbox search or a mail header.</summary>
public class EmailAndSearchTermTests
{
    [Theory]
    [InlineData("kari@havbris.no", true)]
    [InlineData("o'brien+crm@sub.havbris.no", true)]
    [InlineData("bjørn@blåbær.no", true)]
    [InlineData("a\"b@havbris.no", false)]
    [InlineData("kari@havbris.no\n", false)]
    [InlineData("kari @havbris.no", false)]
    [InlineData("kari@havbris", false)]
    [InlineData("kari@@havbris.no", false)]
    [InlineData("<kari@havbris.no>", false)]
    [InlineData("kari@havbris.no, ola@havbris.no", false)]
    [InlineData("kari@havbris.no\" OR from:ceo@x.no", false)]
    [InlineData("", false)]
    public void Only_a_plain_address_is_an_address(string value, bool expected) => EmailAddresses.IsValid(value).ShouldBe(expected);

    [Fact]
    public void A_search_term_cannot_leave_its_quotes()
    {
        GraphMailbox.KqlTerm("kari@havbris.no").ShouldBe("kari@havbris.no");
        var hostile = GraphMailbox.KqlTerm("x\" OR participants:\"ceo@bank.no\\\r\n");
        hostile.ShouldNotContain("\"");
        hostile.ShouldNotContain("\\");
        hostile.ShouldNotContain("\r");
        hostile.ShouldNotContain("\n");
    }
}
