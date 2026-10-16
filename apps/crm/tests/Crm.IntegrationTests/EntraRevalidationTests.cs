using Crm.Web.Auth;
using Microsoft.Identity.Client;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-10: which failures of the hourly refresh-token check mean "Entra did not answer" (the check waits five minutes) as
/// opposed to an answer about the account or an unexpected error (both end the request as before).
/// </summary>
public sealed class EntraRevalidationTests
{
    public static TheoryData<string, Exception, bool> Failures => new()
    {
        { "network", new HttpRequestException("no route"), true },
        { "timeout", new TimeoutException(), true },
        { "HttpClient timeout", new TaskCanceledException(), true },
        { "Entra 503", new MsalServiceException(MsalError.ServiceNotAvailable, "unavailable", 503), true },
        { "Entra throttling", new MsalServiceException("temporarily_unavailable", "throttled", 429), true },
        { "MSAL timeout", new MsalClientException(MsalError.RequestTimeout, "timed out"), true },
        { "bad client credentials", new MsalServiceException("invalid_client", "AADSTS7000215", 401), false },
        { "other client error", new MsalClientException("invalid_authority", "bad authority"), false },
        { "a bug", new InvalidOperationException(), false },
    };

    [Theory]
    [MemberData(nameof(Failures))]
    public void Only_a_silent_entra_postpones_the_check(string what, Exception failure, bool postponed) =>
        AuthenticationSetup.IsUnavailable(failure, CancellationToken.None).ShouldBe(postponed, what);

    [Fact]
    public void A_request_the_browser_gave_up_on_is_not_an_outage()
    {
        using var aborted = new CancellationTokenSource();
        aborted.Cancel();
        AuthenticationSetup.IsUnavailable(new OperationCanceledException(aborted.Token), aborted.Token).ShouldBeFalse();
    }
}
