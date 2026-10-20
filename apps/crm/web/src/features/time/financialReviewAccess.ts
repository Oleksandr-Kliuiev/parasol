import { Permissions, type Permission } from '../../auth/CurrentUserContext';

export const financialReviewPermissions: Permission[] = [Permissions.timeRead, Permissions.financeRead,
  Permissions.contractsRead, Permissions.billingRead, Permissions.customersRead];
