using System.Net;
using System.Net.Sockets;

namespace Crm.IntegrationTests;

/// <summary>
/// A TCP proxy in front of SQL Server that a test can take down and bring back (DEV-06): while it is down, every open
/// connection is cut and new ones are refused at once, as when the database becomes unreachable.
/// </summary>
internal sealed class TcpToggleProxy : IDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly string _targetHost;
    private readonly int _targetPort;
    private readonly List<TcpClient> _open = [];
    private readonly Lock _lock = new();
    private readonly CancellationTokenSource _stop = new();
    private volatile bool _down;

    public TcpToggleProxy(string targetHost, int targetPort)
    {
        _targetHost = targetHost;
        _targetPort = targetPort;
        _listener.Start();
        _ = AcceptAsync();
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    public void Down()
    {
        _down = true;
        lock (_lock)
        {
            foreach (var client in _open)
            {
                client.Dispose();
            }

            _open.Clear();
        }
    }

    public void Up() => _down = false;

    private async Task AcceptAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }

            if (_down)
            {
                client.Dispose();
                continue;
            }

            _ = PumpAsync(client);
        }
    }

    private async Task PumpAsync(TcpClient client)
    {
        var server = new TcpClient();
        try
        {
            await server.ConnectAsync(_targetHost, _targetPort, _stop.Token);
            lock (_lock)
            {
                _open.Add(client);
                _open.Add(server);
            }

            var up = client.GetStream().CopyToAsync(server.GetStream(), _stop.Token);
            var downstream = server.GetStream().CopyToAsync(client.GetStream(), _stop.Token);
            await Task.WhenAny(up, downstream);
        }
        catch (Exception)
        {
            // A cut connection ends here.
        }
        finally
        {
            client.Dispose();
            server.Dispose();
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        Down();
        _stop.Dispose();
    }
}
