using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Core.Parasol;

/// <summary>Bounded, server-only reads on fixed Atlas routes. No redirects, cookies, retries or upstream error text.</summary>
public sealed class AtlasReadClient(IOptions<AtlasWorkspaceOptions> options, IHttpClientFactory clients)
{
    public Task<AtlasReadResponse> IdentityExportAsync(AtlasEmployeeCredential credential, CancellationToken ct) =>
        ReadAsync("clients/identity-export", credential, 1_048_576, ct);

    public Task<AtlasReadResponse> OverviewAsync(string clientId, AtlasEmployeeCredential credential, CancellationToken ct) =>
        ReadAsync($"clients/{Uri.EscapeDataString(clientId)}/overview", credential, 2 * 1024 * 1024, ct);

    internal Task<AtlasReadResponse> ObservationAsync(string clientId, string observationId, AtlasEmployeeCredential credential, CancellationToken ct) =>
        ReadAsync($"clients/{Uri.EscapeDataString(clientId)}/observations/{Uri.EscapeDataString(observationId)}", credential, 1_048_576, ct,
            notFound: "OBSERVATION_NOT_FOUND");

    internal Task<AtlasReadResponse> ObservationsAsync(string clientId, AtlasEmployeeCredential credential,
        AtlasObservationSelection selection, string? cursor, CancellationToken ct) =>
        ReadAsync($"clients/{Uri.EscapeDataString(clientId)}/observations?limit=25&status={Uri.EscapeDataString(selection.AtlasStatuses)}"
            + $"&severity={Uri.EscapeDataString(selection.AtlasSeverities)}"
            + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}"), credential, 1_048_576, ct, cursor is not null);

    private async Task<AtlasReadResponse> ReadAsync(string path, AtlasEmployeeCredential credential, int maximumBytes, CancellationToken ct,
        bool cursorRequest = false, string notFound = "SOURCE_NOT_FOUND")
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var client = clients.CreateClient(AtlasWorkspaceRegistration.ClientName);
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(options.Value.BaseUrl), path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) return new("ACCESS_DENIED");
            if (response.StatusCode == HttpStatusCode.NotFound) return new(notFound);
            if (cursorRequest && response.StatusCode == HttpStatusCode.BadRequest) return new("INVALID_CURSOR");
            if (!response.IsSuccessStatusCode) return new("UNAVAILABLE");
            if (response.Content.Headers.ContentLength > maximumBytes || response.Content.Headers.ContentType?.MediaType != "application/json")
                return new("INVALID_RESPONSE");
            await using var input = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var buffer = new MemoryStream();
            var chunk = new byte[8192];
            int read;
            while ((read = await input.ReadAsync(chunk, timeout.Token)) > 0)
            {
                if (buffer.Length + read > maximumBytes) return new("INVALID_RESPONSE");
                buffer.Write(chunk, 0, read);
            }
            return new("READY", JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 32 }));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return new("UNAVAILABLE"); }
        catch (Exception ex) when (ex is HttpRequestException or IOException) { return new("UNAVAILABLE"); }
        catch (JsonException) { return new("INVALID_RESPONSE"); }
    }
}

public sealed class AtlasReadResponse(string status, JsonDocument? document = null) : IDisposable
{
    public string Status { get; } = status;
    public JsonDocument? Document { get; } = document;
    public void Dispose() => Document?.Dispose();
}
