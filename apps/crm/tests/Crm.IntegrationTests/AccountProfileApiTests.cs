using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.Identity.Contracts;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

/// <summary>
/// The account page shows the signed-in person what the directory says about them: the job title and department the Entra
/// sync keeps, and when they signed in. It reads them from /bff/user, so they need no permission of their own.
/// </summary>
public sealed class AccountProfileApiTests(CrmWebFactory factory)
{
    private const string Tenant = "11111111-1111-1111-1111-111111111111";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task The_signed_in_person_sees_their_sign_in_time_and_what_the_directory_gives()
    {
        var key = "account-" + Guid.NewGuid().ToString("N");
        // The role with the fewest permissions: one's own profile needs none.
        var me = factory.ClientAs(CrmRoles.ReadOnly, key);

        var before = await me.GetFromJsonAsync<JsonElement>("/bff/user", Ct);
        before.GetProperty("lastLoginAt").GetDateTimeOffset().ShouldBeGreaterThan(DateTimeOffset.UtcNow.AddHours(-1));
        before.GetProperty("jobTitle").ValueKind.ShouldBe(JsonValueKind.Null);
        before.GetProperty("department").ValueKind.ShouldBe(JsonValueKind.Null);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            // The sync applies a profile it read whole: with the name the directory gives.
            await scope.ServiceProvider.GetRequiredService<IUserDirectorySync>().ApplyAsync(
                [new DirectoryUserChange(Tenant, $"test-{key}", false, true, $"Test {key}", null, null, "Operations", "Technician")], Ct);
        }

        var after = await me.GetFromJsonAsync<JsonElement>("/bff/user", Ct);
        after.GetProperty("jobTitle").GetString().ShouldBe("Technician");
        after.GetProperty("department").GetString().ShouldBe("Operations");
    }
}
