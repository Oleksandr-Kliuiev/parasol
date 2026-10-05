/** The roles of the CRM as the server knows them (CrmRoles.All): an explanation names the one that owns the difference. */
export const ownerRoles = ['Crm.Admin', 'Crm.Management', 'Crm.Sales', 'Crm.Technician', 'Crm.ServiceLead', 'Crm.Finance', 'Crm.ReadOnly'] as const;

export const EXPLANATION_MIN = 10;
export const EXPLANATION_MAX = 1000;
export const FALLBACK_MIN = 10;
export const FALLBACK_MAX = 2000;


export const CSV_HEADER = 'orgnr;period;currency;group;productCode;quantity;amountExVat;externalRef';
