using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.CloudAlly;

/// <summary>
/// The partner's access token (M42), cached and shared by every request. The first one comes from signing in as the API user
/// (<c>POST v2/auth/partner</c>: the application's <c>client-id</c> and <c>client-secret</c> headers, the user's e-mail and password
/// in the body); later ones from the refresh token (<c>POST v2/auth/refresh</c>) while CloudAlly still accepts it, and from a new
/// sign-in when it does not. Modelled on <c>PowerOfficeTokenProvider</c>.
/// </summary>
public sealed class CloudAllyTokenProvider(IHttpClientFactory httpClientFactory, IOptions<CloudAllyOptions> options, TimeProvider timeProvider) : IDisposable
{
    public const string HttpClientName = "cloudally-token";
    public const string ClientIdHeader = "client-id";
    public const string ClientSecretHeader = "client-secret";
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _token;
    private DateTimeOffset _expiresAt;
    private string? _refreshToken;
    private DateTimeOffset _refreshExpiresAt;

    public async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (_token is not null && timeProvider.GetUtcNow() < _expiresAt)
        {
            return _token;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = timeProvider.GetUtcNow();
            if (_token is not null && now < _expiresAt)
            {
                return _token;
            }

            var token = (_refreshToken is not null && now < _refreshExpiresAt ? await RefreshAsync(_refreshToken, cancellationToken) : null)
                        ?? await SignInAsync(cancellationToken);
            now = timeProvider.GetUtcNow();
            _token = token.AccessToken;
            _expiresAt = TokenLifetime.ExpiresAt(now, token.ExpiresIn, TokenLifetime.AccessFallback);
            if (!string.IsNullOrWhiteSpace(token.RefreshToken))
            {
                _refreshToken = token.RefreshToken;
                _refreshExpiresAt = TokenLifetime.ExpiresAt(now, token.RefreshTokenExpiresIn, TokenLifetime.RefreshFallback);
            }

            return _token;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The access token was refused: the next request asks for a new one (the refresh token is kept).</summary>
    public void Invalidate() => _token = null;

    public void Dispose() => _gate.Dispose();

    /// <summary>The application's id and secret, which every authorization call and the closing of an account carry.</summary>
    public static void AddApplication(HttpRequestHeaders headers, CloudAllyOptions options)
    {
        headers.Remove(ClientIdHeader);
        headers.Remove(ClientSecretHeader);
        headers.Add(ClientIdHeader, options.ClientId?.Trim());
        headers.Add(ClientSecretHeader, options.ClientSecret?.Trim());
    }

    private async Task<TokenAnswer> SignInAsync(CancellationToken cancellationToken)
    {
        var o = options.Value;
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(o.BaseUrl, "v2/auth/partner"))
        {
            Content = JsonContent.Create(new { email = o.Email?.Trim(), password = o.Password }),
        };
        return await SendAsync(request, "sign-in", cancellationToken)
               ?? throw new HttpRequestException("CloudAlly refused the sign-in. Check the client id and secret and the API user's e-mail and password.",
                   null, HttpStatusCode.Unauthorized);
    }

    /// <summary>A new access token from the refresh token, or null when CloudAlly no longer takes it (sign in again then).</summary>
    private async Task<TokenAnswer?> RefreshAsync(string refreshToken, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(options.Value.BaseUrl, "v2/auth/refresh"))
        {
            Content = JsonContent.Create(new { refreshToken }),
        };
        var answer = await SendAsync(request, "refresh", cancellationToken);
        if (answer is null)
        {
            _refreshToken = null;
        }

        return answer;
    }

    /// <summary>The token answer; null when CloudAlly refused the credentials (400, 401, 403); any other failure throws.</summary>
    private async Task<TokenAnswer?> SendAsync(HttpRequestMessage request, string what, CancellationToken cancellationToken)
    {
        AddApplication(request.Headers, options.Value);
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await httpClientFactory.CreateClient(HttpClientName).SendAsync(request, cancellationToken);
        if (response.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return null;
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"CloudAlly {what} failed with {(int)response.StatusCode}.", null, response.StatusCode);
        }

        var token = await response.Content.ReadFromJsonAsync<TokenAnswer>(cancellationToken);
        return token is { AccessToken.Length: > 0 }
            ? token
            : throw new HttpRequestException($"CloudAlly answered the {what} without an access token.");
    }

    private sealed record TokenAnswer(
        [property: JsonPropertyName("accessToken")] string AccessToken,
        [property: JsonPropertyName("expiresIn")] long? ExpiresIn,
        [property: JsonPropertyName("refreshToken")] string? RefreshToken,
        [property: JsonPropertyName("refreshTokenExpiresIn")] long? RefreshTokenExpiresIn);
}

/// <summary>
/// When a CloudAlly token stops being usable. The reference calls <c>expiresIn</c> an "expiration date" of type int64 without a
/// unit, so the value is read for what it can be: a Unix time in milliseconds or in seconds, otherwise seconds from now. A minute
/// of margin is kept, and no token is trusted longer than <see cref="Longest"/>.
/// </summary>
internal static class TokenLifetime
{
    public static readonly TimeSpan AccessFallback = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan RefreshFallback = TimeSpan.FromHours(12);
    public static readonly TimeSpan Longest = TimeSpan.FromDays(7);
    private static readonly TimeSpan Margin = TimeSpan.FromMinutes(1);

    public static DateTimeOffset ExpiresAt(DateTimeOffset now, long? value, TimeSpan fallback)
    {
        var at = value switch
        {
            null or <= 0 => now + fallback,
            >= 100_000_000_000 => DateTimeOffset.FromUnixTimeMilliseconds(Math.Min(value.Value, 253_402_300_799_000)),
            >= 1_000_000_000 => DateTimeOffset.FromUnixTimeSeconds(Math.Min(value.Value, 253_402_300_799)),
            _ => now + TimeSpan.FromSeconds(value.Value),
        };
        if (at > now + Longest)
        {
            at = now + Longest;
        }

        // A token that is already past its time (or nearly) is still used once: the 401 that follows asks for a new one.
        return at - Margin > now ? at - Margin : now + TimeSpan.FromSeconds(5);
    }
}

/// <summary>
/// Adds the partner's bearer token and the application's id and secret, which CloudAlly's own client sends with every call (the
/// reference declares them on some calls only). On 401 or 403 — CloudAlly answers an expired token with either, and did nothing — it
/// fetches a new token once and repeats the request.
/// </summary>
internal sealed class CloudAllyAuthHandler(CloudAllyTokenProvider tokens, IOptions<CloudAllyOptions> options) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        CloudAllyTokenProvider.AddApplication(request.Headers, options.Value);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync(cancellationToken));
        var response = await base.SendAsync(request, cancellationToken);
        if (response.StatusCode is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden))
        {
            return response;
        }

        response.Dispose();
        tokens.Invalidate();
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await tokens.GetTokenAsync(cancellationToken));
        return await base.SendAsync(request, cancellationToken);
    }
}
