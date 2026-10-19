import type { ReactElement } from 'react';
import {
  ArrowImport20Regular,
  ArrowSwap20Regular,
  Board20Regular,
  BoardSplit20Regular,
  Box20Regular,
  Building20Regular,
  Clock20Regular,
  ContactCard20Regular,
  DataFunnel20Regular,
  DataTrending20Regular,
  DataUsage20Regular,
  DocumentBulletList20Regular,
  DocumentSearch20Regular,
  DocumentText20Regular,
  KeyMultiple20Regular,
  LockClosed20Regular,
  People20Regular,
  PersonLock20Regular,
  PersonSettings20Regular,
  PlugConnected20Regular,
  Receipt20Regular,
  ShieldTask20Regular,
  TaskListSquareLtr20Regular,
  TextboxSettings20Regular,
  Timer20Regular,
  Wrench20Regular,
} from '@fluentui/react-icons';
import { Permissions, useCan } from '../auth/CurrentUserContext';

export interface NavEntry {
  value: string;
  path: string;
  /** i18n key under `nav.` */
  label: string;
  icon: ReactElement;
  /** A server page outside the SPA (Hangfire dashboard): opens in its own tab. */
  external?: boolean;
}

export interface NavGroup {
  key: 'work' | 'customers' | 'finance' | 'system';
  /** i18n key under `nav.` */
  label: string;
  items: NavEntry[];
}

/** Order matters: the first prefix that matches wins, so a longer path comes before its parent. */
const selectedByPrefix: ReadonlyArray<readonly [string, string]> = [
  ['/organizations', 'organizations'],
  ['/contacts', 'organizations'],
  ['/dashboard', 'dashboard'],
  ['/billing/invoices', 'invoices'],
  ['/billing', 'billing'],
  ['/quotes', 'quotes'],
  ['/admin/quote-templates', 'quote-templates'],
  ['/pipeline', 'pipeline'],
  ['/sales/leads', 'leads'],
  ['/projects', 'projects'],
  ['/licenses', 'licenses'],
  ['/admin/pipeline', 'pipeline-stages'],
  ['/time/entries', 'time-entries'],
  ['/time', 'timesheet'],
  ['/admin/technicians', 'technicians'],
  ['/contracts', 'contracts'],
  ['/catalog', 'catalog'],
  ['/admin/audit', 'audit'],
  ['/admin/record-access', 'record-access'],
  ['/admin/users', 'users'],
  ['/admin/integrations', 'integrations'],
  ['/admin/mappings', 'mappings'],
  ['/admin/migration', 'migration'],
  ['/admin/custom-fields', 'custom-fields'],
  ['/admin/privacy', 'privacy'],
  ['/admin/maintenance', 'maintenance'],
  ['/reports/margins', 'margins'],
  ['/service/sla', 'sla'],
];

export function selectedNavValue(pathname: string): string {
  return selectedByPrefix.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? 'my-day';
}

/**
 * The menu follows the work, not the modules (UX concept §4): Work, Customers, Finance, System. Every entry keeps the
 * permission it had before the regrouping; a group with no visible entry is dropped.
 */
export function useNavGroups(): NavGroup[] {
  const canAudit = useCan(Permissions.auditRead);
  const canUsers = useCan(Permissions.usersRead);
  const canJobs = useCan(Permissions.integrationsManage);
  const canCatalog = useCan(Permissions.catalogRead);
  const canContracts = useCan(Permissions.contractsRead);
  const canOwnTime = useCan(Permissions.timeOwn);
  const canReadTime = useCan(Permissions.timeRead);
  const canManageTime = useCan(Permissions.timeManage);
  const canSales = useCan(Permissions.salesRead);
  const canSalesWrite = useCan(Permissions.salesWrite);
  const canLicensing = useCan(Permissions.licensingRead);
  const canProjects = useCan(Permissions.projectsRead);
  const canBilling = useCan(Permissions.billingRead);
  const canReports = useCan(Permissions.reportsRead);
  const canMargins = useCan(Permissions.financeCostRead);
  const canService = useCan(Permissions.serviceRead);
  const canCustomFields = useCan(Permissions.customFieldsManage);
  const canDeleteCustomers = useCan(Permissions.customersDelete);
  const canPrivacy = useCan(Permissions.privacyManage);
  const canMaintenance = useCan(Permissions.operationsMaintenance);
  const canTime = canOwnTime || canReadTime;
  // As before the regrouping, the administration entries appear only for someone who holds one of these six rights.
  const canSystem = canAudit || canUsers || canJobs || canSalesWrite || canPrivacy || canMaintenance;
  const canTimeAll = canReadTime || canManageTime;

  const entry = (
    visible: boolean,
    value: string,
    path: string,
    label: string,
    icon: ReactElement,
    external = false,
  ): NavEntry[] => (visible ? [{ value, path, label, icon, ...(external ? { external } : {}) }] : []);

  const groups: NavGroup[] = [
    {
      key: 'work',
      label: 'sectionWork',
      items: [
        ...entry(true, 'my-day', '/', 'myDay', <Board20Regular />),
        ...entry(canTime, 'timesheet', '/time', 'timesheet', <Clock20Regular />),
        ...entry(canTimeAll, 'time-entries', '/time/entries', 'timeEntries', <Clock20Regular />),
      ],
    },
    {
      key: 'customers',
      label: 'sectionCustomers',
      items: [
        ...entry(true, 'organizations', '/organizations', 'organizations', <Building20Regular />),
        ...entry(canContracts, 'contracts', '/contracts', 'contracts', <DocumentText20Regular />),
        ...entry(canSales, 'pipeline', '/pipeline', 'pipeline', <DataFunnel20Regular />),
        ...entry(canSales, 'leads', '/sales/leads', 'leads', <ContactCard20Regular />),
        ...entry(canSales, 'quotes', '/quotes', 'quotes', <DocumentText20Regular />),
        ...entry(canProjects, 'projects', '/projects', 'projects', <TaskListSquareLtr20Regular />),
        ...entry(canLicensing, 'licenses', '/licenses', 'licenses', <KeyMultiple20Regular />),
        ...entry(canCatalog, 'catalog', '/catalog', 'catalog', <Box20Regular />),
      ],
    },
    {
      key: 'finance',
      label: 'sectionFinance',
      items: [
        ...entry(canBilling, 'billing', '/billing', 'billing', <DocumentBulletList20Regular />),
        ...entry(canBilling, 'invoices', '/billing/invoices', 'invoices', <Receipt20Regular />),
        ...entry(canReports, 'dashboard', '/dashboard', 'dashboard', <DataTrending20Regular />),
        ...entry(canMargins, 'margins', '/reports/margins', 'margins', <DataUsage20Regular />),
        ...entry(canService, 'sla', '/service/sla', 'sla', <ShieldTask20Regular />),
      ],
    },
    {
      key: 'system',
      label: 'sectionSystem',
      items: [
        ...entry(canSystem && canAudit, 'audit', '/admin/audit', 'audit', <DocumentSearch20Regular />),
        ...entry(canSystem && canAudit, 'record-access', '/admin/record-access', 'recordAccess', <LockClosed20Regular />),
        ...entry(canSystem && canUsers, 'users', '/admin/users', 'users', <People20Regular />),
        ...entry(canSystem && canJobs, 'integrations', '/admin/integrations', 'integrations', <PlugConnected20Regular />),
        ...entry(canSystem && canSalesWrite, 'quote-templates', '/admin/quote-templates', 'quoteTemplates', <DocumentText20Regular />),
        ...entry(canSystem && canSalesWrite, 'pipeline-stages', '/admin/pipeline', 'pipelineStages', <BoardSplit20Regular />),
        ...entry(canSystem && canJobs, 'technicians', '/admin/technicians', 'technicians', <PersonSettings20Regular />),
        ...entry(canSystem && canDeleteCustomers, 'migration', '/admin/migration', 'migration', <ArrowImport20Regular />),
        ...entry(canSystem && canPrivacy, 'privacy', '/admin/privacy', 'privacy', <PersonLock20Regular />),
        ...entry(canSystem && canCustomFields, 'custom-fields', '/admin/custom-fields', 'customFields', <TextboxSettings20Regular />),
        ...entry(canSystem && canJobs, 'mappings', '/admin/mappings', 'mappings', <ArrowSwap20Regular />),
        ...entry(canSystem && canJobs, 'jobs', '/admin/jobs', 'jobs', <Timer20Regular />, true),
        ...entry(canSystem && canMaintenance, 'maintenance', '/admin/maintenance', 'maintenance', <Wrench20Regular />),
      ],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
