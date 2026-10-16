using System.Security.Claims;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;

namespace Crm.IntegrationTests;

/// <summary>F-G2-08: the re-verification asks Entra for an interactive sign-in and checks what comes back; Entra may ignore max_age.</summary>
public sealed class ReverificationTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(5);

    [Fact]
    public void The_challenge_asks_for_a_login_prompt_and_the_freshness_window_as_max_age()
    {
        var properties = Reverification.Challenge("/billing/runs/r1?tab=bases", MaxAge, "oid-1");

        var challenge = properties.ShouldBeOfType<OpenIdConnectChallengeProperties>();
        challenge.Prompt.ShouldBe("login");
        challenge.MaxAge.ShouldBe(MaxAge);
        challenge.RedirectUri.ShouldBe("/billing/runs/r1?tab=bases");
        Reverification.IsReverification(challenge).ShouldBeTrue();
        Reverification.IsReverification(new AuthenticationProperties()).ShouldBeFalse();
        Reverification.IsReverification(null).ShouldBeFalse();
    }

    [Theory]
    [InlineData(0, null)]
    [InlineData(299, null)]
    [InlineData(300, null)]
    [InlineData(359, null)] // max_age plus the minute of clock skew
    [InlineData(361, "auth_time_too_old")]
    [InlineData(3600, "auth_time_too_old")]
    [InlineData(-30, null)] // an authentication a little in the future is clock skew, not a reason to refuse
    public void An_authentication_older_than_max_age_is_refused_whatever_entra_did_with_the_request(int secondsAgo, string? rejected)
    {
        var principal = Principal(authTime: (Now - TimeSpan.FromSeconds(secondsAgo)).ToUnixTimeSeconds().ToString());

        Reverification.Reject(principal, Reverification.Challenge("/", MaxAge, null), Now, requiredAcr: null).ShouldBe(rejected);
    }

    [Fact]
    public void A_response_without_a_usable_auth_time_is_refused()
    {
        var properties = Reverification.Challenge("/", MaxAge, null);

        Reverification.Reject(Principal(authTime: null), properties, Now, null).ShouldBe("auth_time_missing");
        Reverification.Reject(Principal(authTime: "yesterday"), properties, Now, null).ShouldBe("auth_time_missing");
        Reverification.Reject(Principal(authTime: "0"), properties, Now, null).ShouldBe("auth_time_missing");
    }

    [Fact]
    public void An_ordinary_sign_in_is_not_judged_by_the_reverification_rules()
    {
        var old = Principal(authTime: (Now - TimeSpan.FromHours(3)).ToUnixTimeSeconds().ToString());

        // Silent single sign-on is a valid sign-in; it just does not count as the user being present.
        Reverification.FailureRedirect(old, new AuthenticationProperties { RedirectUri = "/" }, Now, "mfa", out var reason).ShouldBeNull();
        reason.ShouldBeNull();
        Reverification.Reject(old, new AuthenticationProperties(), Now, null).ShouldBe("not_a_reverification");
    }

    [Fact]
    public void The_answer_must_come_from_the_account_that_asked()
    {
        var properties = Reverification.Challenge("/", MaxAge, "oid-1");

        Reverification.Reject(Principal(objectId: "oid-1"), properties, Now, null).ShouldBeNull();
        Reverification.Reject(Principal(objectId: "OID-1"), properties, Now, null).ShouldBeNull();
        Reverification.Reject(Principal(objectId: "oid-2"), properties, Now, null).ShouldBe("other_account");
    }

    [Fact]
    public void A_required_acr_is_compared_with_the_claim_and_ignored_when_empty()
    {
        var properties = Reverification.Challenge("/", MaxAge, null);

        Reverification.Reject(Principal(acr: null), properties, Now, "").ShouldBeNull();
        Reverification.Reject(Principal(acr: null), properties, Now, "  ").ShouldBeNull();
        Reverification.Reject(Principal(acr: "1"), properties, Now, "mfa").ShouldBe("acr_mismatch");
        Reverification.Reject(Principal(acr: null), properties, Now, "mfa").ShouldBe("acr_mismatch");
        Reverification.Reject(Principal(acr: "mfa"), properties, Now, "mfa").ShouldBeNull();
    }

    [Theory]
    [InlineData("/billing/runs/r1", "/billing/runs/r1?reverify=failed")]
    [InlineData("/billing/runs?tab=bases", "/billing/runs?tab=bases&reverify=failed")]
    [InlineData("/page#section", "/page?reverify=failed")]
    [InlineData("//evil.example", "/?reverify=failed")]
    [InlineData("https://evil.example/", "/?reverify=failed")]
    [InlineData("/\\evil.example", "/?reverify=failed")]
    [InlineData("", "/?reverify=failed")]
    public void A_failed_reverification_goes_back_to_a_page_of_this_app_and_never_elsewhere(string returnUrl, string expected) =>
        Reverification.WithFailure(returnUrl).ShouldBe(expected);

    [Fact]
    public void The_api_offers_a_fixed_relative_address_under_the_sign_in_path()
    {
        Reverification.Url.ShouldBe("/bff/login?reverify=1");
        ReturnUrl.IsSafe(Reverification.Url).ShouldBeTrue();
    }

    // authTime "now" is the default; null leaves the claim out.
    private static ClaimsPrincipal Principal(string? authTime = "now", string? objectId = null, string? acr = null)
    {
        var claims = new List<Claim> { new(CrmClaimTypes.ObjectId, objectId ?? "oid-1") };
        if (authTime is not null)
        {
            claims.Add(new Claim("auth_time", authTime == "now" ? Now.ToUnixTimeSeconds().ToString() : authTime));
        }

        if (acr is not null)
        {
            claims.Add(new Claim("acr", acr));
        }

        return new ClaimsPrincipal(new ClaimsIdentity(claims, "test"));
    }
}
