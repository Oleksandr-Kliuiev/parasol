import type { ProjectStatus } from './types';

/** Badge colour per project status; outline badges keep the dark-theme contrast check happy. */
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
