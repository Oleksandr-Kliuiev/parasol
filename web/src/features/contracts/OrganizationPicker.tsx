import { useState } from 'react';
import { Combobox, Option } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { OrganizationListItem, PagedResult } from '../../api/types';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import type { Ref } from './types';

export function OrganizationPicker({ value, onChange, id, disabled }: { value: Ref | null; onChange: (value: Ref | null) => void; id?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value?.name ?? '');
  const search = useDebouncedValue(text);
  const term = search === value?.name ? '' : search;
  const { data } = useQuery({
    queryKey: ['organizations', 'picker', term],
    queryFn: async ({ signal }) =>
      (await api.get<PagedResult<OrganizationListItem>>(`/api/v1/customers/organizations${query({ search: term, limit: 20 })}`, signal)).data,
    staleTime: 30_000,
  });
  const options = [...(value && !data?.items.some((o) => o.id === value.id) ? [{ id: value.id, name: value.name }] : []), ...(data?.items ?? [])];

  return (
    <Combobox
      id={id}
      disabled={disabled}
      freeform={false}
      placeholder={t('contracts.form.organizationPlaceholder')}
      value={text}
      selectedOptions={value ? [value.id] : []}
      onInput={(event) => setText((event.target as HTMLInputElement).value)}
      onOptionSelect={(_, d) => {
        const selected = options.find((o) => o.id === d.optionValue) ?? null;
        onChange(selected ? { id: selected.id, name: selected.name } : null);
        setText(selected?.name ?? '');
      }}
    >
      {options.map((o) => (
        <Option key={o.id} value={o.id} text={o.name}>
          {o.name}
        </Option>
      ))}
    </Combobox>
  );
}
