using System.Reflection;
using Crm.Infrastructure.Documents;
using Crm.Infrastructure.Health;
using Crm.Infrastructure.Outbox;
using Crm.Infrastructure.Persistence;
using Crm.SharedKernel.Application;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Domain;
using FluentValidation;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.DependencyInjection;

/// <summary>All module DbContext types, in migration order (Audit first).</summary>
public sealed class ModuleDbContextRegistry
{
    private readonly List<Type> _contexts = [];

    public IReadOnlyList<Type> Contexts => _contexts;

    internal void Add(Type type)
    {
        if (!_contexts.Contains(type))
        {
            _contexts.Add(type);
        }
    }
}

public static class ModuleRegistration
{
    public const string ConnectionStringName = "crm";

    public static IServiceCollection AddCrmInfrastructure(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddScoped<IRequestContext, NullRequestContext>();
        services.TryAddScoped<MessageHandlingContext>();
        services.TryAddScoped<AuditingInterceptor>();
        services.TryAddSingleton(new ModuleDbContextRegistry());
        services.TryAddSingleton<OutboxEventTypeResolver>();
        services.TryAddScoped<OutboxRetentionJob>();
        // The loop monitor and its settings exist in every host, so the outbox can be worked anywhere (tests, tools).
        if (services.All(d => d.ServiceType != typeof(ProcessingLoopMonitor)))
        {
            services.AddSingleton<ProcessingLoopMonitor>();
            services.AddOptions<ProcessingHealthOptions>().BindConfiguration(ProcessingHealthOptions.SectionName);
            services.AddOptions<OutboxOptions>().BindConfiguration(OutboxOptions.SectionName);

            // DEV-08: issued documents (quote PDFs) live in a document store, never re-rendered from changing data.
            services.AddOptions<DocumentStoreOptions>().BindConfiguration(DocumentStoreOptions.SectionName).ValidateOnStart();
            services.AddSingleton<IValidateOptions<DocumentStoreOptions>, DocumentStoreOptionsValidation>();
            services.TryAddSingleton<IDocumentStore>(sp =>
            {
                var options = sp.GetRequiredService<IOptions<DocumentStoreOptions>>().Value;
                if (options.Provider == DocumentStoreProvider.AzureBlob)
                {
                    options.ManagedIdentityClientId ??= sp.GetRequiredService<IConfiguration>()["AZURE_CLIENT_ID"];
                    return AzureBlobDocumentStore.Create(options);
                }

                var root = Path.IsPathRooted(options.RootPath)
                    ? options.RootPath
                    : Path.Combine(sp.GetRequiredService<IHostEnvironment>().ContentRootPath, options.RootPath);
                return new FileSystemDocumentStore(root);
            });
        }

        return services;
    }

    public static IServiceCollection AddModuleDbContext<TContext>(this IServiceCollection services, IConfiguration configuration)
        where TContext : ModuleDbContext
    {
        services.AddCrmInfrastructure();
        var registry = (ModuleDbContextRegistry)services.First(d => d.ServiceType == typeof(ModuleDbContextRegistry)).ImplementationInstance!;
        registry.Add(typeof(TContext));

        var schema = SchemaOf<TContext>();

        services.AddDbContext<TContext>((sp, options) =>
        {
            // Resolved lazily so hosts and tests can supply configuration after registration.
            var connectionString = sp.GetRequiredService<IConfiguration>().GetConnectionString(ConnectionStringName)
                                   ?? throw new InvalidOperationException($"Connection string '{ConnectionStringName}' is not configured.");
            options.UseSqlServer(connectionString, sql =>
            {
                sql.MigrationsHistoryTable("__EFMigrationsHistory", schema);
                sql.EnableRetryOnFailure(maxRetryCount: 5);
            });
            options.AddInterceptors(sp.GetRequiredService<AuditingInterceptor>());
        });
        return services;
    }

    /// <summary>Registers command/query handlers, validators and domain event handlers found in a module assembly.</summary>
    public static IServiceCollection AddModuleServices(this IServiceCollection services, Assembly assembly)
    {
        Type[] handlerInterfaces = [typeof(ICommandHandler<,>), typeof(IQueryHandler<,>), typeof(IDomainEventHandler<>)];
        foreach (var type in assembly.GetTypes().Where(t => t is { IsClass: true, IsAbstract: false }))
        {
            foreach (var implemented in type.GetInterfaces().Where(i => i.IsGenericType))
            {
                var definition = implemented.GetGenericTypeDefinition();
                if (handlerInterfaces.Contains(definition))
                {
                    services.AddScoped(implemented, type);
                    if (definition != typeof(IDomainEventHandler<>))
                    {
                        services.TryAddScoped(type);
                    }
                }
            }
        }

        services.AddValidatorsFromAssembly(assembly, ServiceLifetime.Scoped, includeInternalTypes: true);
        return services;
    }

    private static string SchemaOf<TContext>() where TContext : ModuleDbContext
    {
        var field = typeof(TContext).GetField("SchemaName", BindingFlags.Public | BindingFlags.Static)
                    ?? throw new InvalidOperationException($"{typeof(TContext).Name} must declare 'public const string SchemaName'.");
        return (string)field.GetValue(null)!;
    }
}
