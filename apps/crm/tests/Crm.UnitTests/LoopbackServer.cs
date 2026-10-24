using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Crm.UnitTests;

/// <summary>One request as it reached a <see cref="LoopbackServer"/>: the query as sent, still escaped.</summary>
internal sealed record LoopbackRequest(string Method, string Path, string Query, Dictionary<string, string> Headers);

/// <summary>
/// A plain HTTP server on a free loopback port that records what reaches it: the address a provider client must or must not
/// call (M39.0 redirects, the partner billing export's links).
/// </summary>
internal sealed class LoopbackServer : IAsyncDisposable
{
    private readonly WebApplication _app;
    private readonly List<LoopbackRequest> _requests = [];

    private LoopbackServer(WebApplication app) => _app = app;

    public Uri Address { get; private set; } = null!;

    public List<LoopbackRequest> Requests
    {
        get { lock (_requests) return _requests.ToList(); }
    }

    public static async Task<LoopbackServer> StartAsync(Func<HttpContext, Task> answer)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        var server = new LoopbackServer(builder.Build());
        server._app.Run(async context =>
        {
            lock (server._requests)
            {
                server._requests.Add(new LoopbackRequest(
                    context.Request.Method,
                    context.Request.Path.Value ?? string.Empty,
                    context.Request.QueryString.Value ?? string.Empty,
                    context.Request.Headers.ToDictionary(h => h.Key, h => h.Value.ToString(), StringComparer.OrdinalIgnoreCase)));
            }

            await answer(context);
        });
        await server._app.StartAsync();
        var bound = server._app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        server.Address = new Uri(bound.TrimEnd('/') + "/");
        return server;
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }
}
