using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Security.Persistence;

/// <summary>The security module's schema (M40.S): only the outbox every module has, until M41 adds Huntress's data.</summary>
public sealed class SecurityDbContext(DbContextOptions<SecurityDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "security";

    public override string Schema => SchemaName;

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
    }
}

internal sealed class SecurityDesignTimeFactory() : ModuleDesignTimeFactory<SecurityDbContext>(SecurityDbContext.SchemaName);
