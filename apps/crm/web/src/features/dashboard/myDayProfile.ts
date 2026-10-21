import { Permissions } from '../../auth/CurrentUserContext';

/** How "My day" is laid out (UX concept §6): the questions differ by job, the panels are the same existing ones. */
export type MyDayProfile = 'work' | 'lead' | 'finance';

export type MainSection = 'alerts' | 'tasks' | 'deals' | 'licensing' | 'billing' | 'organizations';
export type SideSection = 'hours' | 'reminders' | 'registry' | 'quick';

const profiles: readonly MyDayProfile[] = ['work', 'lead', 'finance'];

/**
 * The layouts that differ for this person: the lead one adds the hours review, the finance one starts with billing. Everybody
 * has full access (M38), so everybody gets all three; a narrower test role is not offered a layout whose first panel it lacks.
 */
export function availableProfiles(permissions: readonly string[]): readonly MyDayProfile[] {
  return profiles.filter((profile) => profile === 'work'
    || permissions.includes(profile === 'lead' ? Permissions.timeManage : Permissions.billingRead));
}

/**
 * The layout the person chose and the CRM keeps with them (M38). With every permission for everybody, a layout that followed
 * the permissions would give everybody the finance one; nothing chosen, or a layout this person is not offered, is work.
 */
export function myDayProfile(chosen: string | null | undefined, permissions: readonly string[]): MyDayProfile {
  return availableProfiles(permissions).find((profile) => profile === chosen) ?? 'work';
}

// Urgent alerts and personal tasks come first in the work and lead layouts; M34 section links reach both in every layout.
export const mainOrder: Record<MyDayProfile, readonly MainSection[]> = {
  work: ['alerts', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  lead: ['alerts', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  finance: ['billing', 'licensing', 'deals', 'alerts', 'tasks', 'organizations'],
};

export const sideOrder: Record<MyDayProfile, readonly SideSection[]> = {
  work: ['reminders', 'registry', 'quick'],
  lead: ['hours', 'reminders', 'registry', 'quick'],
  finance: ['reminders', 'registry', 'quick'],
};
