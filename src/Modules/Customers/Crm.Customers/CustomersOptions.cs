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
}
