using Crm.Infrastructure.DependencyInjection;
using Crm.Security.Persistence;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Security;

/// <summary>
/// The security module (M40.S, schema <c>security</c>): empty until M41 brings Huntress, its agents and incidents, and the coverage
/// rules that compare them with Atera's. It is registered now, so its schema, its grants and the module rules stand before then.
/// </summary>
public static class SecurityModule
{
    public static IServiceCollection AddSecurityModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<SecurityDbContext>(configuration);
        services.AddModuleServices(typeof(SecurityModule).Assembly);
        return services;
    }
}
