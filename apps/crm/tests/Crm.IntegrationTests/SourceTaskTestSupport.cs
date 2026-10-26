using System.Net.Http.Json;
using System.Text.Json;
using Crm.Activities.Contracts;
using Crm.Authorization;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.IntegrationTests;

internal static class SourceTaskTestSupport
{
    /// <summary>The subject the tests' tasks are made with: an alert title an employee confirmed.</summary>
    internal const string Subject = "Synthetic disk almost full";

    /// <summary>A fresh Atera alert as a receipt names it: the source's customer and alert ids, never a CRM row.</summary>
    internal static SourceTaskIdentity Source() => new("atera", "alert", "atera-customer-" + Guid.NewGuid().ToString("N")[..8],
        "alert-" + Guid.NewGuid().ToString("N"), "Task");
    internal static async Task<Guid> Employee(CrmWebFactory factory, string role)
    {
        using var client = factory.ClientAs(role, "source-task-" + Guid.NewGuid().ToString("N"));
        return (await client.GetFromJsonAsync<JsonElement>("/bff/user")).GetProperty("id").GetGuid();
    }
    internal static async Task<Guid> Organization(CrmWebFactory factory)
    {
        using var client = factory.ClientAs(CrmRoles.Admin);
        // Merge tests need compatible customers; TestData.Organization assigns different legal organization numbers.
        return await client.CreateOrganizationAsync(new { name = "Source task " + Guid.NewGuid().ToString("N") + " AS", status = "Customer" });
    }
    internal static WebApplicationFactory<Program> Host(CrmWebFactory factory, Guid employee, string role = CrmRoles.Technician,
        Action<IServiceCollection>? configure = null) => factory.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
        {
            services.AddScoped<ICurrentUser>(_ => new EmployeeUser(employee, role));
            configure?.Invoke(services);
        }));
    internal static async Task<Result<SourceTaskRef>> Create(WebApplicationFactory<Program> host, SourceTaskDraft draft)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IActivitiesApi>().CreateTaskOnceAsync(draft, default);
    }
    internal static async Task<Result<SourceTaskRef?>> Find(WebApplicationFactory<Program> host, SourceTaskIdentity source, Guid organizationId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IActivitiesApi>().FindSourceTaskAsync(source, organizationId, default);
    }
    private sealed class EmployeeUser(Guid employee, string role) : ICurrentUser
    {
        public Guid? UserId => employee;
        public string DisplayName => "Synthetic technical employee";
        public bool IsAuthenticated => true;
        public bool HasPermission(string permission) => Permissions.ForRoles([role]).Contains(permission);
    }
}
