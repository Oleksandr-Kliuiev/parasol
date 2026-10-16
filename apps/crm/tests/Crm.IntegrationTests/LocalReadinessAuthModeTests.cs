using System.Net;
using System.Net.Http.Json;
using Crm.Authorization;
using Crm.Integrations.Core.Parasol;
using Crm.Web.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

public sealed class LocalReadinessAuthModeTests(CrmWebFactory factory)
{
    [Theory]
    [InlineData(AuthMode.Entra, "ENTRA")]
    [InlineData(AuthMode.Development, "DEVELOPMENT")]
    public async Task Readiness_uses_the_same_bound_singleton_as_the_actual_authentication_setup(AuthMode mode, string expected)
    {
        var userKey = "readiness-auth-" + Guid.NewGuid().ToString("N");
        await using var host = factory.WithWebHostBuilder(builder =>
        {
            if (mode == AuthMode.Development) builder.UseEnvironment("Development");
            builder.UseSetting("Auth:Mode", mode.ToString());
        });
        host.Services.GetRequiredService<CrmAuthOptions>().Mode.ShouldBe(mode);
        using var client = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userKey);
        var response = await client.GetAsync("/api/v1/parasol/local-readiness");
        response.StatusCode.ShouldBe(HttpStatusCode.OK); response.Headers.CacheControl!.NoStore.ShouldBeTrue();
        (await response.Content.ReadFromJsonAsync<LocalReadinessView>())!.Admin!.AuthMode.ShouldBe(expected);
        await using var scope = host.Services.CreateAsyncScope();
        scope.ServiceProvider.GetRequiredService<ILocalReadinessFlags>().Read().AuthMode.ShouldBe(expected);
    }
}
