import { useState } from 'react';
import { Combobox, Option } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../../api/client';
import type { OrganizationListItem, PagedResult } from '../../../api/types';
import { useDebouncedValue } from '../../../shared/utils/useDebouncedValue';
import { useOrganization } from '../../organizations/api';

/**
 * The customer filter of the alert queue: a search over customers that can be cleared. The address holds only the id; the name of
 * a customer chosen elsewhere (a link) is read once to show it.
 */
export function AlertCustomerFilter({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { t } = useTranslation();
  const chosen = useOrganization(value ?? undefined);
  const chosenName = value && chosen.data ? chosen.data.data.name : '';
  const [text, setText] = useState(chosenName);
  // A customer named by the address (or cleared by Back) shows its name once it is known.
  const [shownFor, setShownFor] = useState(chosenName);
  if (shownFor !== chosenName) { setShownFor(chosenName); setText(chosenName); }
  const search = useDebouncedValue(text);
  const term = search === chosenName ? '' : search;
  const { data } = useQuery({
    queryKey: ['organizations', 'picker', term],
    queryFn: async ({ signal }) =>
      (await api.get<PagedResult<OrganizationListItem>>(`/api/v1/customers/organizations${query({ search: term, limit: 20 })}`, signal)).data,
    staleTime: 30_000,
  });
  const options = [...(value && chosenName && !data?.items.some((o) => o.id === value) ? [{ id: value, name: chosenName }] : []), ...(data?.items ?? [])];
  return (
    <Combobox
      clearable
      freeform={false}
      placeholder={t('alerts.anyCustomer')}
      value={text}
      selectedOptions={value ? [value] : []}
      onInput={(event) => setText((event.target as HTMLInputElement).value)}
      onOptionSelect={(_, d) => {
        const selected = options.find((o) => o.id === d.optionValue) ?? null;
        setText(selected?.name ?? '');
        onChange(selected?.id ?? null);
      }}
    >
      {options.map((o) => <Option key={o.id} value={o.id} text={o.name}>{o.name}</Option>)}
    </Combobox>
  );
}
