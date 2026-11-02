using Crm.Catalog.Contracts;
using Crm.Customers.Contracts;
using Crm.Integrations.Core.Persistence;

namespace Crm.Integrations.Core;

/// <summary>
/// Describes a record type an adapter imports, and what CRM entity it maps to. <paramref name="Importable"/> is false for a type that is
/// only linked, never turned into a new CRM record (a SharePoint folder is not an organization, M47).
/// </summary>
public sealed record ExternalTypeDescriptor(string System, string ExternalType, string EntityType, string? ParentExternalType = null, bool Importable = true);

/// <summary>Contributed by each adapter (PowerOffice, Atera…): record types, import into the CRM, status and connection test.</summary>
public interface IIntegrationAdapter
{
    string System { get; }

    bool IsEnabled { get; }

    IReadOnlyList<ExternalTypeDescriptor> RecordTypes { get; }

    /// <summary>Organization data from a stored customer record (for matching and import).</summary>
    ExternalOrganizationData? ToOrganizationData(ExternalRecord record);

    /// <summary>Contact data from a stored contact record.</summary>
    ExternalContactData? ToContactData(ExternalRecord record);

    /// <summary>Product data from a stored product record (for SKU matching and import into the catalog).</summary>
    ExternalProductData? ToProductData(ExternalRecord record) => null;

    /// <summary>Operation name that creates the organization in the external system, or null if not supported.</summary>
    string? CreateOrganizationOperation { get; }

    Task<ConnectionTestResult> TestConnectionAsync(CancellationToken cancellationToken);
}

public sealed record ConnectionTestResult(bool Success, string Message);
