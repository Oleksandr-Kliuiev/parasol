import { Permissions } from '../../auth/CurrentUserContext';

/** How "My day" is laid out (UX concept §6): the questions differ by job, the panels are the same existing ones. */
export type MyDayProfile = 'work' | 'lead' | 'finance';

export type MainSection = 'tasks' | 'deals' | 'licensing' | 'billing' | 'organizations';
export type SideSection = 'hours' | 'reminders' | 'registry' | 'quick';

/**
 * The profile follows what the user may do, not the role name: whoever runs billing sees money first, whoever approves
 * hours sees the review entry first, everybody else starts with their own tasks.
 */
export function myDayProfile(permissions: readonly string[]): MyDayProfile {
  const has = (permission: string) => permissions.includes(permission);
  if (has(Permissions.billingManage) || has(Permissions.billingApprove) || has(Permissions.billingApproveSecond)) return 'finance';
  if (has(Permissions.timeManage)) return 'lead';
  return 'work';
}

// The work and lead profiles start with personal tasks; M34 section links reach them directly in every profile.
export const mainOrder: Record<MyDayProfile, readonly MainSection[]> = {
  work: ['tasks', 'deals', 'licensing', 'billing', 'organizations'],
  lead: ['tasks', 'deals', 'licensing', 'billing', 'organizations'],
  finance: ['billing', 'licensing', 'deals', 'tasks', 'organizations'],
};

export const sideOrder: Record<MyDayProfile, readonly SideSection[]> = {
  work: ['reminders', 'registry', 'quick'],
  lead: ['hours', 'reminders', 'registry', 'quick'],
  finance: ['reminders', 'registry', 'quick'],
};
