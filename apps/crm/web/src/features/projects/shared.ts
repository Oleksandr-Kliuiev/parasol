import type { ProjectStatus } from './types';

/** Pill colour per project status; the global badge style keeps each tint readable in both themes. */
export function statusColor(status: ProjectStatus): 'brand' | 'success' | 'warning' | 'danger' | 'informative' {
  switch (status) {
    case 'Active':
      return 'brand';
    case 'Completed':
      return 'success';
    case 'OnHold':
      return 'warning';
    case 'Cancelled':
      return 'danger';
    default:
      return 'informative';
  }
}
