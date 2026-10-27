using Crm.Integrations.MicrosoftGraph;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.Identity.Client;
using Microsoft.Identity.Web;

namespace Crm.Web.Auth;

/// <summary>
/// Hands the Microsoft Graph integration an access token for the person who is signed in, taken from the BFF's token
/// cache (docs/03 §6). Without a session — background jobs, the development sign-in, a user who has not consented —
/// there is no token, and the delegated features report themselves as not connected rather than failing.
/// </summary>
internal sealed class EntraDelegatedTokenSource(
    ITokenAcquisition tokens,
    IHttpContextAccessor http,
    ILogger<EntraDelegatedTokenSource> logger) : IDelegatedTokenSource
{
    public async Task<string?> GetTokenAsync(IReadOnlyList<string> scopes, CancellationToken cancellationToken)
    {
        var user = http.HttpContext?.User;
        if (user?.Identity?.IsAuthenticated != true)
        {
            return null;
        }

        try
        {
            // Named for the same reason as the session revalidation: the default scheme is the cookie, which has no Entra options.
            return await tokens.GetAccessTokenForUserAsync(
                scopes, authenticationScheme: OpenIdConnectDefaults.AuthenticationScheme, user: user);
        }
        catch (MicrosoftIdentityWebChallengeUserException exception)
        {
            // Consent for the calendar/mail scopes has not been given yet; the feature stays off for this user.
            logger.LogDebug(exception, "No delegated Graph token for the signed-in user.");
            return null;
        }
        catch (MsalException exception)
        {
            logger.LogDebug(exception, "The delegated Graph token could not be acquired.");
            return null;
        }
    }
}
