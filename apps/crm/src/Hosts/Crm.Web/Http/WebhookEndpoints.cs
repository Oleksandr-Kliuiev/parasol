using Crm.Integrations.Core.Webhooks;

namespace Crm.Web.Http;

/// <summary>
/// The addresses vendors send their webhooks to (M44): <c>POST /webhooks/{system}</c> for a vendor that signs its deliveries (Huntress,
/// through Svix) and <c>POST /webhooks/{system}/{key}</c> for one that can only call an address (Atera's automation rules). A vendor has
/// no session and sends no CSRF header, so the source proves the sender from the delivery as it arrived; the path is outside
/// <c>/api</c> and <c>/bff</c>, has a budget of its own per client address and is answered 503 while the CRM is read-only. A source that
/// is switched off answers 404 as if the address did not exist; a refused delivery 401, noted with the system and the reason only; an
/// accepted one 204 once the early reads it asks for are filed. Nothing in a body reaches a module: crm-worker reads the vendor's API.
/// </summary>
internal static class WebhookEndpoints
{
    public const string PathPrefix = "/webhooks";

    public static IEndpointRouteBuilder MapWebhookEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup(PathPrefix).AllowAnonymous().ExcludeFromDescription();
        group.MapPost("/{system}", (string system, HttpContext http, IEnumerable<IWebhookSource> sources, WebhookInbox inbox, TimeProvider time) =>
            ReceiveAsync(system, null, http, sources, inbox, time));
        group.MapPost("/{system}/{key}", (string system, string key, HttpContext http, IEnumerable<IWebhookSource> sources, WebhookInbox inbox, TimeProvider time) =>
            ReceiveAsync(system, key, http, sources, inbox, time));
        return app;
    }

    private static async Task<IResult> ReceiveAsync(
        string system, string? key, HttpContext http, IEnumerable<IWebhookSource> sources, WebhookInbox inbox, TimeProvider time)
    {
        var ct = http.RequestAborted;
        if (sources.FirstOrDefault(s => string.Equals(s.System, system, StringComparison.Ordinal)) is not { IsEnabled: true } source)
        {
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "NOT_FOUND");
        }

        if (await ReadBodyAsync(http.Request, ct) is not { } body)
        {
            return Results.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: "WEBHOOK_TOO_LARGE");
        }

        var now = time.GetUtcNow();
        var check = source.Check(new WebhookDelivery(http.Request.Headers, key, body), now);
        if (check.Reading is not { } reading)
        {
            var refusal = check.Refusal ?? WebhookRefusal.Unsigned;
            SecurityLog.For(http).WebhookRefused(http, source.System, refusal.ToString());
            await inbox.RefusedAsync(source.System, refusal, now, ct);
            return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "WEBHOOK_REFUSED");
        }

        await inbox.AcceptAsync(source.System, reading, now, ct);
        return Results.NoContent();
    }

    /// <summary>The body exactly as it arrived, or null when it is larger than <see cref="WebhookEvents.MaxBodyBytes"/>.</summary>
    private static async Task<byte[]?> ReadBodyAsync(HttpRequest request, CancellationToken ct)
    {
        if (request.ContentLength > WebhookEvents.MaxBodyBytes)
        {
            return null;
        }

        using var body = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (body.Length + read > WebhookEvents.MaxBodyBytes)
            {
                return null;
            }

            body.Write(chunk, 0, read);
        }

        return body.ToArray();
    }
}
