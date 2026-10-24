import { Permissions } from '../../auth/CurrentUserContext';

/** How "My day" is laid out (UX concept §6): the questions differ by job, the panels are the same existing ones. */
export type MyDayProfile = 'work' | 'lead' | 'finance';

export type MainSection = 'attention' | 'tasks' | 'deals' | 'licensing' | 'billing' | 'organizations';
export type SideSection = 'hours' | 'reminders' | 'registry' | 'quick';

/**
 * The profile follows what the user may do, not the role name: whoever runs billing sees money first, whoever approves
 * hours sees the review entry first, everybody else starts with technical attention and their own tasks.
 */
export function myDayProfile(permissions: readonly string[]): MyDayProfile {
  const has = (permission: string) => permissions.includes(permission);
  if (has(Permissions.billingManage) || has(Permissions.billingApprove) || has(Permissions.billingApproveSecond)) return 'finance';
  if (has(Permissions.timeManage)) return 'lead';
  return 'work';
}

// Technical attention stays above personal tasks for everyone who can read it: an existing acceptance test pins that order
// (M34 section links reach the tasks directly).
export const mainOrder: Record<MyDayProfile, readonly MainSection[]> = {
  work: ['attention', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  lead: ['attention', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  finance: ['billing', 'licensing', 'deals', 'attention', 'tasks', 'organizations'],
};

export const sideOrder: Record<MyDayProfile, readonly SideSection[]> = {
  work: ['reminders', 'registry', 'quick'],
  lead: ['hours', 'reminders', 'registry', 'quick'],
  finance: ['reminders', 'registry', 'quick'],
};
