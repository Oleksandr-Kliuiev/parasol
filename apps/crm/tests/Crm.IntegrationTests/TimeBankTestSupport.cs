using System.Net.Http.Json;
using System.Text.Json;
using Crm.Authorization;
using Crm.TimeTracking.Features;
using Microsoft.Extensions.DependencyInjection;
using static Crm.IntegrationTests.SourceTaskTestSupport;
using static Crm.IntegrationTests.TimePeriodTestSupport;

namespace Crm.IntegrationTests;

internal static class TimeBankTestSupport
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    internal static async Task<(Guid Org, Guid Employee, Guid Bank, Guid Entry, DateOnly Date)> Setup(CrmWebFactory factory, decimal hours)
    {
        var date = TimePeriodTestSupport.Date(); var org = await Organization(factory); var employee = await Employee(factory, CrmRoles.ServiceLead);
        using var admin = factory.ClientAs(CrmRoles.Admin);
        using var response = await admin.PostAsJsonAsync("/api/v1/contracts/hour-banks", new { organizationId = org, name = "Synthetic recovery bank " + Guid.NewGuid().ToString("N"), hours = 10m, validFrom = date.AddYears(-1), overageRate = 100m }, Ct);
        response.EnsureSuccessStatusCode(); var bank = (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();
        await using var host = Host(factory, employee, CrmRoles.ServiceLead); await using var scope = host.Services.CreateAsyncScope();
        var entry = (await scope.ServiceProvider.GetRequiredService<TimeEntryService>().CreateAsync(Request(org, date, Guid.NewGuid()) with { Hours = hours }, Ct)).Value.Id;
        return (org, employee, bank, entry, date);
    }
}
