using System.Reflection;
using NetArchTest.Rules;

namespace Crm.ArchitectureTests;

/// <summary>Enforces the module rules from docs/03-architecture.md §5.2.</summary>
public class ModuleBoundaryTests
{
    private static readonly Assembly SharedKernel = typeof(Crm.SharedKernel.Domain.Entity).Assembly;
    private static readonly Assembly Customers = typeof(Crm.Customers.CustomersModule).Assembly;
    private static readonly Assembly CustomersContracts = typeof(Crm.Customers.Contracts.ICustomersApi).Assembly;
    private static readonly Assembly Identity = typeof(Crm.Identity.IdentityModule).Assembly;
    private static readonly Assembly IdentityContracts = typeof(Crm.Identity.Contracts.IUserDirectory).Assembly;
    private static readonly Assembly Audit = typeof(Crm.Audit.AuditModule).Assembly;
    private static readonly Assembly Catalog = typeof(Crm.Catalog.CatalogModule).Assembly;
    private static readonly Assembly CatalogContracts = typeof(Crm.Catalog.Contracts.ICatalogApi).Assembly;
    private static readonly Assembly Contracts = typeof(Crm.Contracts.ContractsModule).Assembly;
    private static readonly Assembly ContractsContracts = typeof(Crm.Contracts.Contracts.IContractsApi).Assembly;
    private static readonly Assembly Service = typeof(Crm.Service.ServiceModule).Assembly;
    private static readonly Assembly ServiceContracts = typeof(Crm.Service.Contracts.IServiceApi).Assembly;
    private static readonly Assembly TimeTracking = typeof(Crm.TimeTracking.TimeTrackingModule).Assembly;
    private static readonly Assembly TimeTrackingContracts = typeof(Crm.TimeTracking.Contracts.ITimeTrackingApi).Assembly;
    private static readonly Assembly Sales = typeof(Crm.Sales.SalesModule).Assembly;
    private static readonly Assembly SalesContracts = typeof(Crm.Sales.Contracts.ISalesApi).Assembly;
    private static readonly Assembly Activities = typeof(Crm.Activities.ActivitiesModule).Assembly;
    private static readonly Assembly ActivitiesContracts = typeof(Crm.Activities.Contracts.ActivityLogged).Assembly;
    private static readonly Assembly Licensing = typeof(Crm.Licensing.LicensingModule).Assembly;
    private static readonly Assembly LicensingContracts = typeof(Crm.Licensing.Contracts.ILicensingApi).Assembly;
    private static readonly Assembly Billing = typeof(Crm.Billing.BillingModule).Assembly;
    private static readonly Assembly BillingContracts = typeof(Crm.Billing.Contracts.IBillingApi).Assembly;
    private static readonly Assembly Notifications = typeof(Crm.Notifications.NotificationsModule).Assembly;
    private static readonly Assembly NotificationsContracts = typeof(Crm.Notifications.Contracts.INotificationsApi).Assembly;
    private static readonly Assembly Reports = typeof(Crm.Reports.ReportsModule).Assembly;
    private static readonly Assembly Brreg = typeof(Crm.Integrations.Brreg.BrregModule).Assembly;

    private static readonly Dictionary<string, Assembly> ModuleImplementations = new()
    {
        ["Crm.Customers"] = Customers,
        ["Crm.Identity"] = Identity,
        ["Crm.Audit"] = Audit,
        ["Crm.Catalog"] = Catalog,
        ["Crm.Contracts"] = Contracts,
        ["Crm.Service"] = Service,
        ["Crm.TimeTracking"] = TimeTracking,
        ["Crm.Sales"] = Sales,
        ["Crm.Activities"] = Activities,
        ["Crm.Licensing"] = Licensing,
        ["Crm.Billing"] = Billing,
        ["Crm.Notifications"] = Notifications,
        ["Crm.Reports"] = Reports,
    };

    public static TheoryData<string> ModuleNames => new(ModuleImplementations.Keys);

    [Theory]
    [MemberData(nameof(ModuleNames))]
    public void Modules_do_not_reference_other_module_implementations(string moduleName)
    {
        var others = ModuleImplementations.Keys
            .Where(name => name != moduleName)
            .SelectMany(name => ImplementationNamespaces(name))
            .ToArray();

        var result = Types.InAssembly(ModuleImplementations[moduleName]).ShouldNot().HaveDependencyOnAny(others).GetResult();

        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [MemberData(nameof(ModuleNames))]
    public void Core_modules_do_not_know_about_integrations(string moduleName)
    {
        var result = Types.InAssembly(ModuleImplementations[moduleName]).ShouldNot().HaveDependencyOn("Crm.Integrations").GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    public static TheoryData<string> IntegrationNames => new(["Brreg", "MicrosoftGraph", "Core", "PowerOffice", "Atera", "PartnerCenter"]);

    [Theory]
    [MemberData(nameof(IntegrationNames))]
    public void Integrations_use_only_module_contracts(string integration)
    {
        var assembly = integration switch
        {
            "Brreg" => Brreg,
            "MicrosoftGraph" => typeof(Crm.Integrations.MicrosoftGraph.MicrosoftGraphModule).Assembly,
            "PowerOffice" => typeof(Crm.Integrations.PowerOffice.PowerOfficeModule).Assembly,
            "Atera" => typeof(Crm.Integrations.Atera.AteraModule).Assembly,
            "PartnerCenter" => typeof(Crm.Integrations.PartnerCenter.PartnerCenterModule).Assembly,
            _ => typeof(Crm.Integrations.Core.SyncRunner).Assembly,
        };
        var implementations = ModuleImplementations.Keys.SelectMany(ImplementationNamespaces).ToArray();
        var result = Types.InAssembly(assembly).ShouldNot().HaveDependencyOnAny(implementations).GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Fact]
    public void Shared_kernel_is_framework_free()
    {
        var result = Types.InAssembly(SharedKernel)
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Crm.Infrastructure")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [InlineData("customers")]
    [InlineData("identity")]
    [InlineData("catalog")]
    [InlineData("contracts")]
    [InlineData("service")]
    [InlineData("timetracking")]
    [InlineData("sales")]
    [InlineData("activities")]
    [InlineData("licensing")]
    [InlineData("billing")]
    [InlineData("notifications")]
    public void Contracts_do_not_depend_on_infrastructure(string module)
    {
        var assembly = module switch
        {
            "customers" => CustomersContracts,
            "identity" => IdentityContracts,
            "catalog" => CatalogContracts,
            "service" => ServiceContracts,
            "timetracking" => TimeTrackingContracts,
            "sales" => SalesContracts,
            "activities" => ActivitiesContracts,
            "licensing" => LicensingContracts,
            "billing" => BillingContracts,
            "notifications" => NotificationsContracts,
            _ => ContractsContracts,
        };
        var result = Types.InAssembly(assembly)
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "Crm.Infrastructure")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    [Theory]
    [InlineData("Customers")]
    [InlineData("Catalog")]
    [InlineData("Contracts")]
    [InlineData("Service")]
    [InlineData("TimeTracking")]
    [InlineData("Sales")]
    [InlineData("Activities")]
    [InlineData("Licensing")]
    [InlineData("Billing")]
    [InlineData("Notifications")]
    public void Domain_types_do_not_depend_on_persistence(string module)
    {
        var result = Types.InAssembly(ModuleImplementations["Crm." + module])
            .That().ResideInNamespace($"Crm.{module}.Domain")
            .ShouldNot().HaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", $"Crm.{module}.Persistence")
            .GetResult();
        result.IsSuccessful.ShouldBeTrue(Describe(result));
    }

    // NetArchTest matches by name prefix and "Crm.Customers" also prefixes "Crm.Customers.Contracts",
    // so implementation types are listed by full name instead of by namespace.
    private static IEnumerable<string> ImplementationNamespaces(string moduleName) =>
        ModuleImplementations[moduleName].GetTypes()
            .Where(t => t.FullName is not null && !t.FullName.Contains('<', StringComparison.Ordinal) && t.DeclaringType is null)
            .Select(t => t.FullName!)
            .Distinct();

    private static string Describe(NetArchTest.Rules.TestResult result) =>
        result.IsSuccessful ? string.Empty : "Violations: " + string.Join(", ", result.FailingTypeNames ?? []);
}
