using Crm.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Crm.Audit.Persistence;

/// <summary>Owns the <c>audit.AuditEntries</c> table; other modules write to it within their own transactions.</summary>
public sealed class AuditDbContext(DbContextOptions<AuditDbContext> options) : ModuleDbContext(options)
{
    public const string SchemaName = "audit";

    public override string Schema => SchemaName;

    protected override bool OwnsAuditTable => true;

    protected override void ConfigureModule(ModelBuilder modelBuilder)
    {
    }
}

internal sealed class AuditDesignTimeFactory() : ModuleDesignTimeFactory<AuditDbContext>(AuditDbContext.SchemaName);
