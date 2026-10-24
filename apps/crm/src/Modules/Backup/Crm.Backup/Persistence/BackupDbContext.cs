using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Backup.Persistence;

/// <summary>The backup module's schema (M40.S): only the outbox every module has, until M42 adds CloudAlly's data.</summary>
public sealed class BackupDbContext(DbContextOptions<BackupDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "backup";

    public override string Schema => SchemaName;

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
    }
}

internal sealed class BackupDesignTimeFactory() : ModuleDesignTimeFactory<BackupDbContext>(BackupDbContext.SchemaName);
