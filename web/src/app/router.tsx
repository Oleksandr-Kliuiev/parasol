import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppShell } from './AppShell';
import { NotFoundPage } from '../features/errors/NotFoundPage';
import { RouteErrorPage } from '../features/errors/RouteErrorPage';

// Each page is loaded on first navigation, so the initial download only contains the shell (docs/03-architecture.md §10).
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      {
        errorElement: <RouteErrorPage />,
        children: [
      { index: true, lazy: async () => ({ Component: (await import('../features/dashboard/MyDayPage')).MyDayPage }) },
      { path: 'organizations', lazy: async () => ({ Component: (await import('../features/organizations/OrganizationsPage')).OrganizationsPage }) },
      { path: 'organizations/new', lazy: async () => ({ Component: (await import('../features/organizations/OrganizationFormPage')).OrganizationFormPage }) },
      { path: 'organizations/duplicates', lazy: async () => ({ Component: (await import('../features/organizations/DuplicatesPage')).DuplicatesPage }) },
      { path: 'organizations/:id', lazy: async () => ({ Component: (await import('../features/organizations/OrganizationDetailPage')).OrganizationDetailPage }) },
      { path: 'organizations/:id/edit', lazy: async () => ({ Component: (await import('../features/organizations/OrganizationFormPage')).OrganizationFormPage }) },
      { path: 'catalog', lazy: async () => ({ Component: (await import('../features/catalog/CatalogPage')).CatalogPage }) },
      { path: 'catalog/products/new', lazy: async () => ({ Component: (await import('../features/catalog/ProductFormPage')).ProductFormPage }) },
      { path: 'catalog/products/:id', lazy: async () => ({ Component: (await import('../features/catalog/ProductDetailPage')).ProductDetailPage }) },
      { path: 'catalog/products/:id/edit', lazy: async () => ({ Component: (await import('../features/catalog/ProductFormPage')).ProductFormPage }) },
      { path: 'catalog/price-lists/:id', lazy: async () => ({ Component: (await import('../features/catalog/PriceListPage')).PriceListPage }) },
      { path: 'contracts', lazy: async () => ({ Component: (await import('../features/contracts/ContractsPage')).ContractsPage }) },
      { path: 'contracts/new', lazy: async () => ({ Component: (await import('../features/contracts/ContractFormPage')).ContractFormPage }) },
      { path: 'contracts/indexation', lazy: async () => ({ Component: (await import('../features/contracts/IndexationPage')).IndexationPage }) },
      { path: 'contracts/sla-policies', lazy: async () => ({ Component: (await import('../features/contracts/SlaPoliciesPage')).SlaPoliciesPage }) },
      { path: 'contracts/hour-banks/:id', lazy: async () => ({ Component: (await import('../features/contracts/HourBankPage')).HourBankPage }) },
      { path: 'contracts/:id', lazy: async () => ({ Component: (await import('../features/contracts/ContractDetailPage')).ContractDetailPage }) },
      { path: 'contracts/:id/edit', lazy: async () => ({ Component: (await import('../features/contracts/ContractFormPage')).ContractFormPage }) },
      { path: 'pipeline', lazy: async () => ({ Component: (await import('../features/sales/PipelinePage')).PipelinePage }) },
      { path: 'sales/leads', lazy: async () => ({ Component: (await import('../features/sales/LeadsPage')).LeadsPage }) },
      { path: 'sales/opportunities/:id', lazy: async () => ({ Component: (await import('../features/sales/OpportunityPage')).OpportunityPage }) },
      { path: 'quotes', lazy: async () => ({ Component: (await import('../features/quotes/QuotesPage')).QuotesPage }) },
      { path: 'quotes/new', lazy: async () => ({ Component: (await import('../features/quotes/QuotePage')).QuotePage }) },
      { path: 'quotes/:id', lazy: async () => ({ Component: (await import('../features/quotes/QuotePage')).QuotePage }) },
      { path: 'reports/margins', lazy: async () => ({ Component: (await import('../features/reports/MarginsPage')).MarginsPage }) },
      { path: 'service/sla', lazy: async () => ({ Component: (await import('../features/service/SlaReportPage')).SlaReportPage }) },
      { path: 'admin/migration', lazy: async () => ({ Component: (await import('../features/admin/MigrationPage')).MigrationPage }) },
      { path: 'admin/custom-fields', lazy: async () => ({ Component: (await import('../features/customfields/CustomFieldsAdminPage')).CustomFieldsAdminPage }) },
      { path: 'dashboard', lazy: async () => ({ Component: (await import('../features/reports/DashboardPage')).DashboardPage }) },
      { path: 'notifications', lazy: async () => ({ Component: (await import('../features/notifications/NotificationsPage')).NotificationsPage }) },
      { path: 'billing', lazy: async () => ({ Component: (await import('../features/billing/BillingRunsPage')).BillingRunsPage }) },
      { path: 'billing/runs/:id', lazy: async () => ({ Component: (await import('../features/billing/BillingRunPage')).BillingRunPage }) },
      { path: 'billing/bases/:id', lazy: async () => ({ Component: (await import('../features/billing/BillingBasisPage')).BillingBasisPage }) },
      { path: 'billing/invoices', lazy: async () => ({ Component: (await import('../features/billing/InvoicesPage')).InvoicesPage }) },
      { path: 'projects', lazy: async () => ({ Component: (await import('../features/projects/ProjectsPage')).ProjectsPage }) },
      { path: 'projects/:id', lazy: async () => ({ Component: (await import('../features/projects/ProjectPage')).ProjectPage }) },
      { path: 'licenses', lazy: async () => ({ Component: (await import('../features/licensing/LicensesPage')).LicensesPage }) },
      { path: 'time', lazy: async () => ({ Component: (await import('../features/time/TimesheetPage')).TimesheetPage }) },
      { path: 'time/entries', lazy: async () => ({ Component: (await import('../features/time/TimeEntriesPage')).TimeEntriesPage }) },
      { path: 'admin/quote-templates', lazy: async () => ({ Component: (await import('../features/quotes/QuoteTemplatesPage')).QuoteTemplatesPage }) },
      { path: 'admin/pipeline', lazy: async () => ({ Component: (await import('../features/admin/PipelineStagesPage')).PipelineStagesPage }) },
      { path: 'admin/technicians', lazy: async () => ({ Component: (await import('../features/admin/TechniciansPage')).TechniciansPage }) },
      { path: 'contacts/:id', lazy: async () => ({ Component: (await import('../features/contacts/ContactPage')).ContactPage }) },
      { path: 'admin/audit', lazy: async () => ({ Component: (await import('../features/audit/AuditLogPage')).AuditLogPage }) },
      { path: 'admin/users', lazy: async () => ({ Component: (await import('../features/admin/UsersPage')).UsersPage }) },
      { path: 'admin/integrations', lazy: async () => ({ Component: (await import('../features/admin/IntegrationsPage')).IntegrationsPage }) },
      { path: 'admin/mappings', lazy: async () => ({ Component: (await import('../features/integrations/MappingsPage')).MappingsPage }) },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
