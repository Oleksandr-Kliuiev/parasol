using Crm.Integrations.PartnerCenter;

namespace Crm.UnitTests;

/// <summary>
/// Where a link named by the partner billing export may go (DEV-21, docs/05 §2.4): the Graph token only to the configured Graph
/// origin, a signed https file in the export storage without it, and nowhere else.
/// </summary>
public class PartnerBillingLinksTests
{
    private static readonly Uri Graph = new("https://graph.microsoft.com/v1.0/");
    private static readonly IList<string> Storage = new PartnerCenterOptions().BillingStorageHostSuffixes;

    /// <summary>A SAS in the shape Microsoft hands out for the export, escaped as in the manifest.</summary>
    private const string Sas = "sv=2021-08-06&se=2026-10-22T12%3A00%3A00Z&sr=d&sp=rl&sdd=7&sig=RpVY0WBGUHJ2APB3N76jtMak8loAWY4oiA0%2FaoJX1bM%3D";

    [Theory]
    [InlineData("https://graph.microsoft.com/v1.0/reports/partners/billing/operations/op-1", "https://graph.microsoft.com/v1.0/reports/partners/billing/operations/op-1")]
    [InlineData("HTTPS://Graph.Microsoft.com:443/v1.0/reports/partners/billing/manifests/m-1", "https://graph.microsoft.com/v1.0/reports/partners/billing/manifests/m-1")]
    [InlineData("reports/partners/billing/operations/op-1", "https://graph.microsoft.com/v1.0/reports/partners/billing/operations/op-1")]
    [InlineData("/v1.0/reports/partners/billing/operations/op-1", "https://graph.microsoft.com/v1.0/reports/partners/billing/operations/op-1")]
    // The base's own scheme without a host is a relative reference (RFC 3986 §5.2.2): a path on Graph, not a way out.
    [InlineData("https:evil.example/x", "https://graph.microsoft.com/v1.0/evil.example/x")]
    public void A_link_on_the_graph_origin_is_sent_with_the_token(string link, string sentTo)
    {
        var (uri, destination) = PartnerBillingLinks.Classify(Graph, link, Storage);

        destination.ShouldBe(PartnerBillingLinks.Destination.Graph);
        uri.AbsoluteUri.ShouldBe(sentTo);
    }

    [Fact]
    public void A_signed_https_file_in_the_export_storage_is_sent_without_the_token_and_with_its_signature_intact()
    {
        var link = "https://adlsreconbuprodeastus201.blob.core.windows.net/billedusagefastpath/v1/part-00049.c000.json.gz?" + Sas;

        var (uri, destination) = PartnerBillingLinks.Classify(Graph, link, Storage);

        destination.ShouldBe(PartnerBillingLinks.Destination.Storage);
        uri.PathAndQuery.ShouldEndWith("?" + Sas);
    }

    [Theory]
    [InlineData("https://graph.microsoft.com.evil.example/v1.0/x", "outside the configured Graph address")]
    [InlineData("https://graph.microsoft.com:8443/v1.0/x", "outside the configured Graph address")]
    [InlineData("http://graph.microsoft.com/v1.0/x", "outside the configured Graph address")]
    [InlineData("https://user@graph.microsoft.com/v1.0/x", "outside the configured Graph address")]
    [InlineData("//evil.example/v1.0/x", "outside the configured Graph address")]
    [InlineData("http:evil.example/x", "outside the configured Graph address")]
    [InlineData("file:///etc/passwd", "outside the configured Graph address")]
    [InlineData("http://169.254.169.254/metadata/identity/oauth2/token?sig=c2ln", "outside the configured Graph address")]
    [InlineData("https://evil.example/part-1.json?sig=c2ln", "outside the configured Graph address")]
    [InlineData("https://evilblob.core.windows.net/part-1.json?sig=c2ln", "outside the configured Graph address")]
    [InlineData("https://blob.core.windows.net.evil.example/part-1.json?sig=c2ln", "outside the configured Graph address")]
    [InlineData("http://account.blob.core.windows.net/part-1.json?sig=c2ln", "a storage link that is not https")]
    [InlineData("https://account.blob.core.windows.net/part-1.json?sv=2021-08-06", "a storage link without a SAS signature")]
    [InlineData("https://account.blob.core.windows.net/part-1.json?sv=2021-08-06&sig=", "a storage link without a SAS signature")]
    public void Any_other_link_is_refused_with_an_error_that_names_none_of_it(string link, string reason)
    {
        var refused = Should.Throw<PartnerBillingLinkRefusedException>(() => PartnerBillingLinks.Classify(Graph, link, Storage));

        refused.Message.ShouldContain(reason);
        refused.Message.ShouldNotContain("evil");
        refused.Message.ShouldNotContain("account.");
        refused.Message.ShouldNotContain("169.254");
        refused.Message.ShouldNotContain("sig=");
    }
}
