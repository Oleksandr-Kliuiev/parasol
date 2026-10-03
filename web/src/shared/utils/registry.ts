import type { RegistryStatus } from '../../api/types';

/** Registry statuses that need the account manager's attention (BR-CUS-03). */
export const registryWarningStatuses: RegistryStatus[] = ['UnderDissolution', 'Bankrupt', 'Deleted', 'NotFound'];
