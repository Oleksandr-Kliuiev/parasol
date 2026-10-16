using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

public sealed class AtlasWorkspaceReader(CustomerIdentityService identities, ICurrentUser user,
    IOptions<AtlasWorkspaceOptions> options, IHttpClientFactory clients)
{
    private const int MaximumBytes = 2 * 1024 * 1024;

    public async Task<Result<AtlasWorkspaceView>> ReadAsync(Guid customerId, CancellationToken ct)
    {
        // Defense in depth: background jobs and other callers cannot bypass the HTTP permission boundary.
        if (user.UserId is not { } employeeId || !user.HasPermission(Permissions.ParasolAtlasRead))
            return Error.Forbidden("PARASOL_ATLAS_FORBIDDEN", "Technical workspace access is required.");
        var identity = await identities.GetAsync(customerId, ct);
        if (!identity.IsSuccess) return identity.Error!;
        var reference = identity.Value.Atlas;
        if (reference is null) return new AtlasWorkspaceView(customerId, "NOT_LINKED");
        var config = options.Value;
        if (!config.Enabled) return new AtlasWorkspaceView(customerId, "NOT_CONFIGURED");
        if (!config.Employees.TryGetValue(employeeId.ToString("D"), out var credential) || credential.WorkspaceId != reference.WorkspaceId)
            return new AtlasWorkspaceView(customerId, "ACCESS_DENIED");

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var client = clients.CreateClient(AtlasWorkspaceRegistration.ClientName);
        // A single fixed read route. Neither a URL nor a scope nor a token can be supplied by the browser.
        using var request = new HttpRequestMessage(HttpMethod.Get,
            new Uri(new Uri(config.BaseUrl), $"clients/{Uri.EscapeDataString(reference.ClientId)}/overview"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new AtlasWorkspaceView(customerId, "ACCESS_DENIED");
            if (response.StatusCode == HttpStatusCode.NotFound) return new AtlasWorkspaceView(customerId, "SOURCE_NOT_FOUND");
            if (!response.IsSuccessStatusCode) return new AtlasWorkspaceView(customerId, "UNAVAILABLE");
            if (response.Content.Headers.ContentLength > MaximumBytes
                || response.Content.Headers.ContentType?.MediaType != "application/json")
                return new AtlasWorkspaceView(customerId, "INVALID_RESPONSE");
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int read;
            while ((read = await input.ReadAsync(chunk, timeout.Token)) > 0)
            {
                if (buffer.Length + read > MaximumBytes) return new AtlasWorkspaceView(customerId, "INVALID_RESPONSE");
                buffer.Write(chunk, 0, read);
            }
            using var json = JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 32 });
            var summary = AtlasWorkspaceProjection.Read(json.RootElement, reference);
            // An unlink/rebind while awaiting the source invalidates this result, including customer merge/deletion.
            var current = await identities.GetAsync(customerId, ct);
            if (!current.IsSuccess) return current.Error!;
            if (current.Value.Atlas != reference) return new AtlasWorkspaceView(customerId, "IDENTITY_CHANGED");
            return new AtlasWorkspaceView(customerId, "READY", summary);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new AtlasWorkspaceView(customerId, "UNAVAILABLE");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException)
        {
            return new AtlasWorkspaceView(customerId, "UNAVAILABLE");
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        {
            return new AtlasWorkspaceView(customerId, "INVALID_RESPONSE");
        }
    }
}
