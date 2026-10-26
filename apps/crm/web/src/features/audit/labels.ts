import { useTranslation } from 'react-i18next';

/** Modules, record types and actions of the audit log in the user's words; a value the interface does not know stays as written. */
export function useAuditLabels() {
  const { t } = useTranslation();
  return {
    module: (value: string) => t(`audit.modules.${value}`, { defaultValue: value }),
    entityType: (value: string) => t(`audit.entityTypes.${value}`, { defaultValue: value }),
    action: (value: string) => t(`audit.actions.${value}`, { defaultValue: value }),
  };
}
