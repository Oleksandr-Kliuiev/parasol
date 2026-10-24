using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Crm.Integrations.Huntress;
using Crm.SharedKernel.Documents;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>
/// Fetching a Huntress report's PDF (M43): the link is followed by hand, at most three redirects, every hop https (http only to a
/// loopback stand-in) on an allowed host; no credential travels; what comes back must be a whole PDF of at most 30 MB. A refusal names
/// its reason and the host only; what may be there tomorrow (a 5xx, 429) throws so the run counts it as not read.
/// </summary>
public sealed class HuntressReportFileClientTests
{
    private static readonly byte[] Pdf = Encoding.Latin1.GetBytes("%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Stub(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(answer(request));
        }
    }

    private static (HuntressReportFileClient Client, Stub Stub) Client(Func<HttpRequestMessage, HttpResponseMessage> answer, params string[] hosts)
    {
        var stub = new Stub(answer);
        var options = Options.Create(new HuntressOptions { ReportFileHosts = [.. hosts] });
        return (new HuntressReportFileClient(new HttpClient(stub), options), stub);
    }

    private static HttpResponseMessage File(byte[] content, string type = "application/pdf")
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(content) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return response;
    }

    private static HttpResponseMessage Redirect(string location) =>
        new(HttpStatusCode.Found) { Headers = { Location = new Uri(location, UriKind.RelativeOrAbsolute) } };

    [Fact]
    public async Task The_link_on_huntress_is_followed_to_its_storage_and_the_whole_pdf_comes_back_without_credentials()
    {
        var (client, stub) = Client(request => request.RequestUri!.Host == "acme.huntress.io"
            ? Redirect("https://files.huntress.io/blobs/synthetic.pdf?sig=abc")
            : File(Pdf));

        var fetch = await client.FetchAsync(new Uri("https://acme.huntress.io/rails/active_storage/blobs/redirect/synthetic.pdf"), Ct);

        fetch.Refusal.ShouldBeNull();
        fetch.Content.ShouldBe(Pdf);
        fetch.Host.ShouldBe("files.huntress.io");
        stub.Requests.Count.ShouldBe(2);
        stub.Requests.ShouldAllBe(r => r.Headers.Authorization == null && r.Method == HttpMethod.Get);
    }

    [Fact]
    public async Task A_relative_redirect_is_resolved_against_the_hop_it_came_from()
    {
        var (client, stub) = Client(request => request.RequestUri!.AbsolutePath.StartsWith("/link", StringComparison.Ordinal)
            ? Redirect("/blob/7.pdf")
            : File(Pdf), "localhost");

        var fetch = await client.FetchAsync(new Uri("http://localhost:5299/link/7.pdf"), Ct);

        fetch.Content.ShouldBe(Pdf);
        stub.Requests[1].RequestUri.ShouldBe(new Uri("http://localhost:5299/blob/7.pdf"));
    }

    [Theory]
    [InlineData("https://reports.example.invalid/7.pdf", "host")]
    [InlineData("http://acme.huntress.io/7.pdf", "scheme")]
    [InlineData("https://user:secret@acme.huntress.io/7.pdf", "scheme")]
    public async Task A_link_off_the_allowed_hosts_or_without_https_is_refused_before_anything_is_asked(string url, string refusal)
    {
        var (client, stub) = Client(_ => File(Pdf));
        var fetch = await client.FetchAsync(new Uri(url), Ct);
        fetch.Refusal.ShouldBe(refusal);
        fetch.Content.ShouldBeNull();
        stub.Requests.ShouldBeEmpty();
    }

    [Fact]
    public async Task A_redirect_to_another_host_is_refused_and_named_by_that_host()
    {
        var (client, stub) = Client(_ => Redirect("https://evil.example.invalid/steal.pdf"));
        var fetch = await client.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct);
        (fetch.Refusal, fetch.Host).ShouldBe(("host", "evil.example.invalid"));
        stub.Requests.Count.ShouldBe(1);
    }

    [Fact]
    public async Task More_than_three_redirects_are_refused()
    {
        var hop = 0;
        var (client, stub) = Client(_ => Redirect($"https://acme.huntress.io/hop/{++hop}"));
        (await client.FetchAsync(new Uri("https://acme.huntress.io/start"), Ct)).Refusal.ShouldBe("redirects");
        stub.Requests.Count.ShouldBe(HuntressReportFileClient.MaxRedirects + 1);
    }

    [Theory]
    [InlineData("text/html", "type")]
    [InlineData("application/json", "type")]
    public async Task A_page_in_place_of_the_file_is_refused(string type, string refusal)
    {
        var (client, _) = Client(_ => File(Encoding.UTF8.GetBytes("<html>Sign in to Huntress</html>"), type));
        (await client.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct)).Refusal.ShouldBe(refusal);
    }

    [Fact]
    public async Task Bytes_that_are_not_a_whole_pdf_are_refused_even_as_application_pdf()
    {
        var (client, _) = Client(_ => File(Encoding.ASCII.GetBytes("%PDF-1.4 truncated without its end")));
        (await client.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct)).Refusal.ShouldBe("pdf");
    }

    [Fact]
    public async Task A_file_larger_than_a_pdf_may_be_is_refused_by_its_length_and_by_what_is_read()
    {
        var (byLength, _) = Client(_ =>
        {
            var response = File(Pdf);
            response.Content.Headers.ContentLength = PdfContent.MaxLength + 1L;
            return response;
        });
        (await byLength.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct)).Refusal.ShouldBe("size");

        var (byBody, _) = Client(_ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StreamContent(new MemoryStream(new byte[PdfContent.MaxLength + 1])) };
            response.Content.Headers.ContentType = new MediaTypeHeaderValue("application/pdf");
            response.Content.Headers.ContentLength = null;
            return response;
        });
        (await byBody.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct)).Refusal.ShouldBe("size");
    }

    [Fact]
    public async Task A_refusing_status_is_a_refusal_and_a_passing_failure_throws_for_the_next_run()
    {
        var (missing, _) = Client(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        (await missing.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct)).Refusal.ShouldBe("status");

        foreach (var status in new[] { HttpStatusCode.ServiceUnavailable, HttpStatusCode.TooManyRequests })
        {
            var (busy, _) = Client(_ => new HttpResponseMessage(status));
            await Should.ThrowAsync<HttpRequestException>(() => busy.FetchAsync(new Uri("https://acme.huntress.io/7.pdf"), Ct));
        }
    }

    [Fact]
    public void The_allowed_hosts_are_huntress_io_until_some_are_set()
    {
        new HuntressOptions().AllowedReportFileHosts.ShouldBe(["huntress.io"]);
        new HuntressOptions { ReportFileHosts = ["blob.core.windows.net"] }.AllowedReportFileHosts.ShouldBe(["blob.core.windows.net"]);
    }
}
