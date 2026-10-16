using Crm.Customers.Contracts;

namespace Crm.Customers;

public sealed class CustomersOptions
{
    public const string SectionName = "Customers";

    /// <summary>
    /// Owner of invoice e-mail, EHF and billing address. With PowerOffice these fields are read-only in the CRM and
    /// updated from PowerOffice; with Crm they are pushed to PowerOffice. Deferred business decision — default Crm.
    /// </summary>
    public BillingDetailsMaster BillingDetailsMaster { get; set; } = BillingDetailsMaster.Crm;

    /// <summary>Rows of the migration import saved in one transaction (DEV-20); a chunk that fails leaves the earlier ones committed.</summary>
    public int MigrationChunkSize { get; set; } = 200;

    /// <summary>A real import run that has not moved for this long is taken as interrupted; repeating the call resumes it.</summary>
    public TimeSpan MigrationRunStaleAfter { get; set; } = TimeSpan.FromMinutes(10);
}
