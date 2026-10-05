import { createContext, useContext } from 'react';
import type { CurrentUser } from '../api/types';

export const Permissions = {
  customersRead: 'customers.read',
  customersWrite: 'customers.write',
  customersDelete: 'customers.delete',
  contactsWrite: 'contacts.write',
  financeRead: 'finance.read',
  financeCostRead: 'finance.cost.read',
  auditRead: 'audit.read',
  usersRead: 'users.read',
  integrationsManage: 'integrations.manage',
  catalogRead: 'catalog.read',
  catalogWrite: 'catalog.write',
  contractsRead: 'contracts.read',
  contractsWrite: 'contracts.write',
  serviceRead: 'service.read',
  serviceWrite: 'service.write',
  timeOwn: 'time.own',
  timeRead: 'time.read',
  timeManage: 'time.manage',
  timeUnlock: 'time.unlock',
  salesRead: 'sales.read',
  salesWrite: 'sales.write',
  salesDiscountApprove: 'sales.discount.approve',
  quotesAll: 'sales.quotes.all',
  licensingRead: 'licensing.read',
  licensingManage: 'licensing.manage',
  activitiesRead: 'activities.read',
  activitiesWrite: 'activities.write',
  billingRead: 'billing.read',
  billingManage: 'billing.manage',
  billingApprove: 'billing.approve',
  billingApproveSecond: 'billing.approve.second',
  billingReconcile: 'billing.reconcile',
  reportsRead: 'reports.read',
  projectsRead: 'projects.read',
  projectsWrite: 'projects.write',
  projectsAll: 'projects.all',
  reportsMart: 'reports.mart',
  customFieldsManage: 'customfields.manage',
  privacyManage: 'privacy.manage',
  operationsMaintenance: 'operations.maintenance',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

export const currentUserQueryKey = ['bff', 'user'] as const;

export const CurrentUserContext = createContext<CurrentUser | null>(null);

export function useCurrentUser(): CurrentUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser must be used inside <AuthGate>.');
  return user;
}

/** UI-only check; the API enforces the same permission on the server. */
export function useCan(permission: Permission): boolean {
  return useCurrentUser().permissions.includes(permission);
}
