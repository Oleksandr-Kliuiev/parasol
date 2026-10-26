import { h } from '../../app/hearth';
import type { TimeClassification, TimeEntry, TimeEntryStatus } from './types';

/** The dot before a status or a part of an approved entry: the colour supports the word, never replaces it. */
export const statusDot: Record<TimeEntryStatus, string> = { New: h.iris, Approved: h.spruce, NonBillable: h.faint, Invoiced: h.ink };
export const classificationDot: Record<TimeClassification, string> = { Covered: h.spruce, HourBank: h.saffron, Rate: h.ember, NonBillable: h.faint };

/** An entry the manager can still approve or withdraw: not in a closed month and not billed yet. */
export const actionable = (entry: TimeEntry) => !entry.isLocked && ['New', 'Approved', 'NonBillable'].includes(entry.status);
/** An entry that can still be corrected before approval. */
export const adjustable = (entry: TimeEntry) => entry.status === 'New' && !entry.isLocked;
