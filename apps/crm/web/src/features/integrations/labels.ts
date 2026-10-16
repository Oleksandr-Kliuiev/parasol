import type { TFunction } from 'i18next';

export const entityTypeOf = (externalType: string): 'Organization' | 'Contact' | 'Product' | null =>
  externalType === 'Customer'
    ? 'Organization'
    : externalType === 'Contact' || externalType === 'ContactPerson'
      ? 'Contact'
      : externalType === 'Product'
        ? 'Product'
        : null;

export const entityRoute = (externalType: string, entityId: string): string | null => {
  const entity = entityTypeOf(externalType);
  return entity === 'Organization'
    ? `/organizations/${entityId}`
    : entity === 'Contact'
      ? `/contacts/${entityId}`
      : entity === 'Product'
        ? `/catalog/products/${entityId}`
        : null;
};

export const systemName = (t: TFunction, system: string) => t(`systems.${system}`, { defaultValue: system });
export const typeName = (t: TFunction, type: string) => t(`externalTypes.${type}`, { defaultValue: type });
