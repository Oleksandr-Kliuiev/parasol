using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Crm.Infrastructure.Persistence;

/// <summary>Lets <c>dotnet ef</c> build a module context without booting a host.</summary>
public abstract class ModuleDesignTimeFactory<TContext>(string schema) : IDesignTimeDbContextFactory<TContext>
    where TContext : ModuleDbContext
{
    public TContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<TContext>()
            .UseSqlServer(
                "Server=localhost;Database=crm_design;Trusted_Connection=False;Encrypt=False",
                sql => sql.MigrationsHistoryTable("__EFMigrationsHistory", schema))
            .Options;
        return (TContext)Activator.CreateInstance(typeof(TContext), options)!;
    }
}
