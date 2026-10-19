using Microsoft.Extensions.Configuration;

namespace Microsoft.Extensions.Hosting;

/// <summary>File-mounted private configuration and a dependency-free container health probe.</summary>
public static class VpsHostConfiguration
{
    public static TBuilder AddVpsConfiguration<TBuilder>(this TBuilder builder, string[] args)
        where TBuilder : IHostApplicationBuilder
    {
        if (Environment.GetEnvironmentVariable("PARASOL_CONFIG_FILE") is { Length: > 0 } path)
        {
            if (!Path.IsPathFullyQualified(path))
            {
                throw new InvalidOperationException("PARASOL_CONFIG_FILE must be an absolute path.");
            }

            // Environment/CLI still win, for example the isolated restore's maintenance lock.
            builder.Configuration.AddJsonFile(path, optional: false, reloadOnChange: false)
                .AddEnvironmentVariables().AddCommandLine(args);
        }

        return builder;
    }

    public static async Task<int> HealthProbeAsync()
    {
        try
        {
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
            {
                Timeout = TimeSpan.FromSeconds(5),
            };
            using var response = await http.GetAsync("http://127.0.0.1:8080/health/ready");
            return response.IsSuccessStatusCode ? 0 : 1;
        }
        catch (HttpRequestException) { return 1; }
        catch (TaskCanceledException) { return 1; }
    }
}
