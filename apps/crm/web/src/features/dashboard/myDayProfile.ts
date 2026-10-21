import { Permissions } from '../../auth/CurrentUserContext';

/** How "My day" is laid out (UX concept §6): the questions differ by job, the panels are the same existing ones. */
export type MyDayProfile = 'work' | 'lead' | 'finance';

export type MainSection = 'hours' | 'alerts' | 'tasks' | 'deals' | 'licensing' | 'billing' | 'organizations';
export type SideSection = 'reminders' | 'registry' | 'quick';
export type Tile = 'alerts' | 'tasks' | 'hours' | 'reminders' | 'overdue' | 'registry';

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

// The first panel and the first key figure answer what the layout says it shows first, at every width: urgent alerts and
// personal tasks (work), the hours to approve (lead), billing (finance). The main column comes first in the reading order, so
// the hours review leads it in the lead layout; M34 section links reach alerts and tasks in every layout.
export const mainOrder: Record<MyDayProfile, readonly MainSection[]> = {
  work: ['alerts', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  lead: ['hours', 'alerts', 'tasks', 'deals', 'licensing', 'billing', 'organizations'],
  finance: ['billing', 'licensing', 'deals', 'alerts', 'tasks', 'organizations'],
};

export const sideOrder: Record<MyDayProfile, readonly SideSection[]> = {
  work: ['reminders', 'registry', 'quick'],
  lead: ['reminders', 'registry', 'quick'],
  finance: ['reminders', 'registry', 'quick'],
};

/** The key figures above the panels, in the same order of questions; four are shown. */
export const tileOrder: Record<MyDayProfile, readonly Tile[]> = {
  work: ['alerts', 'tasks', 'hours', 'reminders', 'registry'],
  lead: ['hours', 'alerts', 'tasks', 'reminders', 'registry'],
  finance: ['overdue', 'alerts', 'reminders', 'hours', 'registry'],
};
