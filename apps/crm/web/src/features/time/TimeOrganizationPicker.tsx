import { useState } from 'react';
import { Combobox, Option } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { OrganizationListItem, PagedResult } from '../../api/types';
import { ErrorState } from '../../shared/components/ErrorState';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import type { Ref } from '../contracts/types';
import { savedServicePolicy } from '../service/useSavedServiceList';

/** The time form's customer search cannot reuse another employee's picker cache. */
export function TimeOrganizationPicker({ value, onChange, scope, disabled, id }: {
  value: Ref | null; onChange: (value: Ref | null) => void; scope: string; disabled: boolean; id?: string;
}) {
  const { t } = useTranslation(); const [text, setText] = useState(value?.name ?? '');
  const search = useDebouncedValue(text); const term = search === value?.name ? '' : search;
  const read = useQuery({
    ...savedServicePolicy, queryKey: ['time-form', scope, 'organizations', term],
    queryFn: async ({ signal }) => {
      const answer = await api.get<PagedResult<OrganizationListItem>>(`/api/v1/customers/organizations${query({ search: term, limit: 20 })}`, signal);
      signal.throwIfAborted(); return answer.data;
    },
  });
  const items = read.isSuccess && !read.isFetching ? read.data.items : [];
  const options = [...(value && !items.some(item => item.id === value.id) ? [value] : []), ...items];
  return <>
    <Combobox id={id} disabled={disabled} freeform={false} value={text} placeholder={t('contracts.form.organizationPlaceholder')}
      selectedOptions={value ? [value.id] : []} onInput={event => setText((event.target as HTMLInputElement).value)}
      onOptionSelect={(_, data) => {
        const selected = options.find(item => item.id === data.optionValue) ?? null;
        onChange(selected ? { id: selected.id, name: selected.name } : null); setText(selected?.name ?? '');
      }}>
      {options.map(item => <Option key={item.id} value={item.id} text={item.name}>{item.name}</Option>)}
    </Combobox>
    {read.error && <ErrorState error={read.error} onRetry={() => void read.refetch()} />}
  </>;
}
