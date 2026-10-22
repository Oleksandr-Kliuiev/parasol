using Crm.Backup.Persistence;
using Crm.Infrastructure.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Backup;

/// <summary>
/// The backup module (M40.S, schema <c>backup</c>): empty until M42 brings CloudAlly, the backups of the customers' Microsoft 365
/// and the coverage rules about them (a failed, late or paused backup, a licensed user nobody backs up). It is registered now, so
/// its schema, its grants and the module rules stand before then.
/// </summary>
public static class BackupModule
{
    public static IServiceCollection AddBackupModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddModuleDbContext<BackupDbContext>(configuration);
        services.AddModuleServices(typeof(BackupModule).Assembly);
        return services;
    }
}
