using System.Net;
using System.Text;
using System.Text.Json;
using Crm.Backup.Contracts;
using Crm.Integrations.CloudAlly;

namespace Crm.UnitTests;

/// <summary>
/// M42: CloudAlly's partner API as the CRM reads it — signing in as the API user with the application's id and secret, the refresh
/// token and a new sign-in when it is refused, paging by CloudAlly's totals and tokens, its open date formats, and its sources.
/// </summary>
public class CloudAllyClientTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 22, 12, 0, 0, TimeSpan.Zero);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static CloudAllyOptions Settings() => new()
    {
        Enabled = true, BaseUrl = new Uri("https://cloudally.test/"), ClientId = "client", ClientSecret = "secret", Email = "api@firm.test",
        Password = "pw", PageSize = 2,
    };

    [Theory]
    [InlineData(3600L, 3600 - 60)]
    [InlineData(null, 600 - 60)]
    [InlineData(0L, 600 - 60)]
    // A Unix time in seconds and in milliseconds, both an hour after the start (13:00 UTC on 22.10.2026).
    [InlineData(1_792_674_000L, 3600 - 60)]
    [InlineData(1_792_674_000_000L, 3600 - 60)]
    // Never trusted longer than a week.
    [InlineData(100_000_000L, 7 * 24 * 3600 - 60)]
    public void A_token_lasts_as_its_expiry_says_less_a_minute(long? expiresIn, int seconds)
    {
        var now = new DateTimeOffset(2026, 10, 22, 12, 0, 0, TimeSpan.Zero);
        (TokenLifetime.ExpiresAt(now, expiresIn, TokenLifetime.AccessFallback) - now).ShouldBe(TimeSpan.FromSeconds(seconds));
    }

    [Fact]
    public void A_token_already_past_its_time_is_used_once_more_for_a_moment()
    {
        TokenLifetime.ExpiresAt(Start, 30, TokenLifetime.AccessFallback).ShouldBe(Start.AddSeconds(5));
        TokenLifetime.ExpiresAt(Start, 1_000_000_000L, TokenLifetime.AccessFallback).ShouldBe(Start.AddSeconds(5));
    }

    [Theory]
    [InlineData("20261022143005", "2026-10-22T14:30:05Z")]
    [InlineData("2026-10-22T14:30:05Z", "2026-10-22T14:30:05Z")]
    [InlineData("2026-10-22T16:30:05+02:00", "2026-10-22T14:30:05Z")]
    [InlineData("1761143405000", "2025-10-22T14:30:05Z")]
    [InlineData("", null)]
    [InlineData("0", null)]
    [InlineData("soon", null)]
    public void Dates_are_read_in_every_form_cloudally_sends(string text, string? expected)
    {
        var parsed = CloudAllyDates.Parse(text);
        parsed.ShouldBe(expected is null ? null : DateTimeOffset.Parse(expected, System.Globalization.CultureInfo.InvariantCulture));
    }

    [Fact]
    public void A_compact_number_is_a_date_and_a_day_is_sent_as_its_end()
    {
        using var json = JsonDocument.Parse("""{"a":20261022143005,"b":"20261021000000"}""");
        CloudAllyDates.Parse(json.RootElement.GetProperty("a")).ShouldBe(new DateTimeOffset(2026, 10, 22, 14, 30, 5, TimeSpan.Zero));
        CloudAllyDates.Newest(json.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value))
            .ShouldBe(new DateTimeOffset(2026, 10, 22, 14, 30, 5, TimeSpan.Zero));
        CloudAllyDates.Compact(new DateOnly(2026, 10, 5)).ShouldBe(20261005235959L);
    }

    [Theory]
    [InlineData("MS365", BackupService.Mail)]
    [InlineData("o365mail", BackupService.Mail)]
    [InlineData("ONEDRIVE", BackupService.OneDrive)]
    [InlineData("SHAREPOINT_MULTI", BackupService.SharePoint)]
    [InlineData("MS365GROUPS", BackupService.Teams)]
    [InlineData("MS365TEAM_CHANNELS", BackupService.Teams)]
    [InlineData("ENTRAID", BackupService.Other)]
    [InlineData(null, BackupService.Other)]
    public void A_source_belongs_to_one_service(string? source, BackupService service) => CloudAllyMapping.ServiceOf(source).ShouldBe(service);

    [Fact]
    public async Task Signing_in_sends_the_application_headers_and_the_api_users_credentials_then_keeps_the_token()
    {
        var (provider, cloudAlly, _) = Tokens();
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.OK, """{"accessToken":"a1","tokenType":"Bearer","expiresIn":3600,"refreshToken":"r1","refreshTokenExpiresIn":86400}""");

        (await provider.GetTokenAsync(Ct)).ShouldBe("a1");
        (await provider.GetTokenAsync(Ct)).ShouldBe("a1");

        var signIn = cloudAlly.Requests.ShouldHaveSingleItem();
        signIn.Headers["client-id"].ShouldBe("client");
        signIn.Headers["client-secret"].ShouldBe("secret");
        using var body = JsonDocument.Parse(signIn.Body);
        body.RootElement.GetProperty("email").GetString().ShouldBe("api@firm.test");
        body.RootElement.GetProperty("password").GetString().ShouldBe("pw");
    }

    [Fact]
    public async Task An_expired_token_is_refreshed_and_a_refused_refresh_signs_in_again()
    {
        var (provider, cloudAlly, time) = Tokens();
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.OK, """{"accessToken":"a1","expiresIn":3600,"refreshToken":"r1","refreshTokenExpiresIn":86400}""");
        cloudAlly.Answer("v2/auth/refresh", HttpStatusCode.OK, """{"accessToken":"a2","expiresIn":3600,"refreshToken":"r2"}""");
        (await provider.GetTokenAsync(Ct)).ShouldBe("a1");

        time.Now = Start.AddHours(2);
        (await provider.GetTokenAsync(Ct)).ShouldBe("a2");
        using (var refresh = JsonDocument.Parse(cloudAlly.Requests[^1].Body))
        {
            refresh.RootElement.GetProperty("refreshToken").GetString().ShouldBe("r1");
        }

        cloudAlly.Answer("v2/auth/refresh", HttpStatusCode.Unauthorized, """{"errorMessage":"Invalid refresh token"}""");
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.OK, """{"accessToken":"a3","expiresIn":3600,"refreshToken":"r3"}""");
        time.Now = Start.AddHours(4);
        (await provider.GetTokenAsync(Ct)).ShouldBe("a3");
        cloudAlly.Requests.Select(r => r.Path).ShouldBe(["/v2/auth/partner", "/v2/auth/refresh", "/v2/auth/refresh", "/v2/auth/partner"]);
    }

    [Fact]
    public async Task Refused_credentials_say_what_to_check()
    {
        var (provider, cloudAlly, _) = Tokens();
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.Unauthorized, """{"errorMessage":"Invalid client credentials"}""");

        var refused = await Should.ThrowAsync<HttpRequestException>(() => provider.GetTokenAsync(Ct));
        refused.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
        refused.Message.ShouldContain("client id and secret");
    }

    [Fact]
    public async Task A_call_carries_the_token_and_the_application_and_a_refused_token_is_renewed_once()
    {
        var (provider, cloudAlly, _) = Tokens();
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.OK, """{"accessToken":"a1","expiresIn":3600,"refreshToken":"r1","refreshTokenExpiresIn":86400}""");
        cloudAlly.Answer("v2/auth/refresh", HttpStatusCode.OK, """{"accessToken":"a2","expiresIn":3600,"refreshToken":"r2"}""");
        var calls = 0;
        cloudAlly.Answer("v2/resellers/accounts", _ => ++calls == 1
            ? (HttpStatusCode.Forbidden, string.Empty)
            : (HttpStatusCode.OK, """{"page":1,"totalPages":1,"data":[{"id":"acc-1","name":"Fjord IT AS"}]}"""));
        var client = Client(cloudAlly, provider);

        var accounts = await ReadAll(client.GetAccountsAsync(Ct));

        accounts.ShouldHaveSingleItem().Name.ShouldBe("Fjord IT AS");
        var reads = cloudAlly.Requests.Where(r => r.Path == "/v2/resellers/accounts").ToList();
        reads.Select(r => r.Headers["Authorization"]).ShouldBe(["Bearer a1", "Bearer a2"]);
        reads.ShouldAllBe(r => r.Headers["client-id"] == "client" && r.Headers["client-secret"] == "secret");
    }

    [Fact]
    public async Task Pages_are_read_up_to_cloudallys_total()
    {
        var (provider, cloudAlly, _) = Tokens();
        SignedIn(cloudAlly);
        cloudAlly.Answer("v2/resellers/accounts/backup-tasks", request => request.Query.Contains("page=1&")
            ? (HttpStatusCode.OK, """{"page":1,"totalPages":2,"data":[{"id":"t1","type":"BACKUP"},{"id":"t2","type":"BACKUP"}]}""")
            : (HttpStatusCode.OK, """{"page":2,"totalPages":2,"data":[{"id":"t3","type":"RESTORE"}]}"""));

        var tasks = await ReadAll(Client(cloudAlly, provider).GetTasksAsync(Ct));

        tasks.Select(t => t.Id).ShouldBe(["t1", "t2", "t3"]);
        tasks.Select(t => t.IsBackup).ShouldBe([true, true, false]);
        cloudAlly.Requests.Count(r => r.Path == "/v2/resellers/accounts/backup-tasks").ShouldBe(2);
    }

    [Fact]
    public async Task Statuses_follow_the_page_token_from_the_second_page_and_a_repeated_token_fails_the_read()
    {
        var (provider, cloudAlly, _) = Tokens();
        SignedIn(cloudAlly);
        cloudAlly.Answer("v2/resellers/accounts/backup-statuses", request => request.Query.Contains("nextPageToken=")
            ? (HttpStatusCode.OK, """{"data":[{"taskId":"t1","entityName":"b@x.no"}],"nextPageToken":null}""")
            : (HttpStatusCode.OK, """{"data":[{"taskId":"t1","entityName":"a@x.no"},{"taskId":"t1","entityName":"c@x.no"}],"nextPageToken":"n2"}"""));

        var statuses = await ReadAll(Client(cloudAlly, provider).GetStatusesAsync(Ct));

        statuses.Select(s => s.EntityName).ShouldBe(["a@x.no", "c@x.no", "b@x.no"]);
        var queries = cloudAlly.Requests.Where(r => r.Path.EndsWith("backup-statuses", StringComparison.Ordinal)).Select(r => r.Query).ToList();
        queries[0].ShouldNotContain("nextPageToken");
        queries[1].ShouldContain("nextPageToken=n2");

        cloudAlly.Answer("v2/resellers/accounts/backup-statuses", _ =>
            (HttpStatusCode.OK, """{"data":[{"taskId":"t1","entityName":"a@x.no"},{"taskId":"t1","entityName":"c@x.no"}],"nextPageToken":"same"}"""));
        await Should.ThrowAsync<CloudAllyApiException>(() => ReadAll(Client(cloudAlly, provider).GetStatusesAsync(Ct)));
    }

    [Fact]
    public async Task A_page_that_cannot_be_read_fails_the_whole_list()
    {
        var (provider, cloudAlly, _) = Tokens();
        SignedIn(cloudAlly);
        cloudAlly.Answer("v2/resellers/bills", request => request.Query.Contains("page=1&")
            ? (HttpStatusCode.OK, """{"page":1,"totalPages":2,"data":[{"userId":"acc-1"},{"userId":"acc-2"}]}""")
            : (HttpStatusCode.BadGateway, string.Empty));

        var failed = await Should.ThrowAsync<CloudAllyApiException>(() => ReadAll(Client(cloudAlly, provider).GetBillsAsync(Ct)));
        failed.Status.ShouldBe(HttpStatusCode.BadGateway);
    }

    [Fact]
    public void A_restore_body_carries_only_what_the_crm_sets()
    {
        var body = CloudAllyClient.Body(new CaRecoveryRequest("t1", "kari@x.no", "MS365", 20261005235959, true, "ext-1", TargetAccount: "ola@x.no"));
        body.Keys.ShouldBe(["taskId", "account", "source", "date", "includeDeleted", "extid", "targetAccount"], ignoreOrder: true);
        CloudAllyClient.Body(new CaRecoveryRequest("t1", "site", "SHAREPOINT_MULTI", 1, false, null, InPlace: true, DownloadToPst: null))
            .Keys.ShouldBe(["taskId", "account", "source", "date", "includeDeleted", "inPlace"], ignoreOrder: true);
    }

    [Theory]
    [InlineData("GET", 500, true)]
    [InlineData("GET", 404, false)]
    [InlineData("POST", 500, false)]
    [InlineData("POST", 429, true)]
    [InlineData("DELETE", 503, false)]
    public void Only_reads_repeat_after_a_failure_and_anything_after_a_throttle(string method, int status, bool repeat) =>
        CloudAllyModule.ShouldRetry(new HttpMethod(method), (HttpStatusCode)status, null).ShouldBe(repeat);

    private static void SignedIn(CloudAlly cloudAlly) =>
        cloudAlly.Answer("v2/auth/partner", HttpStatusCode.OK, """{"accessToken":"a1","expiresIn":3600,"refreshToken":"r1"}""");

    private static (CloudAllyTokenProvider Provider, CloudAlly CloudAlly, ManualTime Time) Tokens()
    {
        var cloudAlly = new CloudAlly();
        var time = new ManualTime(Start);
        return (new CloudAllyTokenProvider(new Factory(cloudAlly), Microsoft.Extensions.Options.Options.Create(Settings()), time), cloudAlly, time);
    }

    private static CloudAllyClient Client(CloudAlly cloudAlly, CloudAllyTokenProvider tokens)
    {
        var options = Microsoft.Extensions.Options.Options.Create(Settings());
        var http = new HttpClient(new CloudAllyAuthHandler(tokens, options) { InnerHandler = cloudAlly }) { BaseAddress = options.Value.BaseUrl };
        return new CloudAllyClient(http, options);
    }

    private static async Task<List<T>> ReadAll<T>(IAsyncEnumerable<T> items)
    {
        var all = new List<T>();
        await foreach (var item in items)
        {
            all.Add(item);
        }

        return all;
    }

    private sealed record Seen(string Path, string Query, Dictionary<string, string> Headers, string Body);

    /// <summary>A stand-in for CloudAlly that answers by path and records every request.</summary>
    private sealed class CloudAlly : HttpMessageHandler
    {
        private readonly Dictionary<string, Func<Seen, (HttpStatusCode, string)>> _answers = new(StringComparer.Ordinal);

        public List<Seen> Requests { get; } = [];

        public void Answer(string path, HttpStatusCode status, string body) => _answers["/" + path] = _ => (status, body);

        public void Answer(string path, Func<Seen, (HttpStatusCode, string)> answer) => _answers["/" + path] = answer;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var headers = request.Headers.ToDictionary(h => h.Key, h => string.Join(",", h.Value), StringComparer.OrdinalIgnoreCase);
            var seen = new Seen(request.RequestUri!.AbsolutePath, request.RequestUri.Query, headers,
                request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken));
            Requests.Add(seen);
            var (status, body) = _answers.TryGetValue(seen.Path, out var answer) ? answer(seen) : (HttpStatusCode.NotFound, string.Empty);
            return new HttpResponseMessage(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        }
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class ManualTime(DateTimeOffset start) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = start;

        public override DateTimeOffset GetUtcNow() => Now;
    }
}
