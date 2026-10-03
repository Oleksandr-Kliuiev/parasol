using System.Net.Http.Json;
using System.Text.Json;
using Crm.Infrastructure.DependencyInjection;
using Crm.Infrastructure.Outbox;
using Crm.Integrations.Core;
using Microsoft.Extensions.DependencyInjection;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

internal static class IntegrationTestHelpers
{
    public static IResponseBuilder JsonReply(object body, int status = 200) =>
        Response.Create().WithStatusCode(status).WithHeader("Content-Type", "application/json").WithBody(JsonSerializer.Serialize(body));

    public static async Task RunJobAsync<TJob>(this CrmWebFactory factory, Func<TJob, Task> run)
        where TJob : notnull
    {
        await using var scope = factory.Services.CreateAsyncScope();
        await run(scope.ServiceProvider.GetRequiredService<TJob>());
    }

    /// <summary>Dispatches domain events of every module (as crm-worker does).</summary>
    public static async Task ProcessEventsAsync(this CrmWebFactory factory)
    {
        var outbox = ActivatorUtilities.CreateInstance<OutboxProcessor>(factory.Services);
        foreach (var context in factory.Services.GetRequiredService<ModuleDbContextRegistry>().Contexts)
        {
            // Other tests create events too; drain the whole outbox, not just the first batch.
            for (int i = 0; i < 50 && await outbox.ProcessContextAsync(context, CancellationToken.None) > 0; i++)
            {
            }
        }
    }

    /// <summary>
    /// Drains the outbox until a condition holds. Test classes run in parallel and share the outbox, so another class can
    /// claim the message this test is waiting for; one drain is therefore not a guarantee that the handler already ran.
    /// </summary>
    public static async Task EventuallyAsync(this CrmWebFactory factory, Func<Task<bool>> condition, int attempts = 10)
    {
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            await factory.ProcessEventsAsync();
            if (await condition())
            {
                return;
            }

            await Task.Delay(100);
        }
    }

    public static async Task<HttpResponseMessage> PutWithETagAsync(this HttpClient client, string url, object body, string etag)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, url) { Content = JsonContent.Create(body) };
        request.Headers.IfMatch.ParseAdd(etag);
        return await client.SendAsync(request);
    }

    public static async Task<HttpResponseMessage> PostWithETagAsync(this HttpClient client, string url, object body, string etag)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(body) };
        request.Headers.IfMatch.ParseAdd(etag);
        return await client.SendAsync(request);
    }

    public static async Task<HttpResponseMessage> DeleteWithETagAsync(this HttpClient client, string url, string etag)
    {
        var request = new HttpRequestMessage(HttpMethod.Delete, url);
        request.Headers.IfMatch.ParseAdd(etag);
        return await client.SendAsync(request);
    }

    public static async Task<JsonElement> ReadJsonAsync(this HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>();

    /// <summary>
    /// Dispatches domain events (as crm-worker does) and processes queued outbound operations, repeatedly: an outbound
    /// operation can raise events of its own (an exported billing basis, for example), which queue more work.
    /// </summary>
    public static async Task ProcessEventsAndOutboundAsync(this CrmWebFactory factory)
    {
        var outbound = factory.Services.GetRequiredService<OutboundProcessorJob>();
        for (int round = 0; round < 4; round++)
        {
            // Other tests create events too; drain the whole outbox, not just the first batch.
            await factory.ProcessEventsAsync();

            var handled = 0;
            for (int i = 0; i < 20; i++)
            {
                var batch = await outbound.RunAsync(CancellationToken.None);
                handled += batch;
                if (batch == 0)
                {
                    break;
                }
            }

            if (handled == 0)
            {
                break;
            }
        }

        await factory.ProcessEventsAsync();
    }

    /// <summary>
    /// Drains events and outbound operations until the billing run has no basis waiting for export and returns its status.
    /// A run also carries bases of other tests' open-ended contracts, and those are sent whenever a parallel test drains
    /// the queue, so the test's own basis being sent says nothing about the run being done.
    /// </summary>
    public static async Task<string> WaitForRunExportAsync(this CrmWebFactory factory, HttpClient client, Guid runId)
    {
        var status = string.Empty;
        for (var attempt = 0; attempt < 15; attempt++)
        {
            await factory.ProcessEventsAndOutboundAsync();
            status = (await client.GetFromJsonAsync<JsonElement>($"/api/v1/billing/runs/{runId}")).GetProperty("status").GetString()!;
            if (status is "Exported" or "ExportedWithErrors")
            {
                break;
            }
        }

        return status;
    }

    public static async Task<Guid> CreateOrganizationAsync(this HttpClient client, object body)
    {
        var response = await client.PostAsJsonAsync("/api/v1/customers/organizations", body);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }
}
