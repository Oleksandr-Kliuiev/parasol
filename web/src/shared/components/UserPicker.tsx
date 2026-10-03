import { useState } from 'react';
import { Combobox, Option, type ComboboxProps } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { UserRef, UserSummary } from '../../api/types';
import { useDebouncedValue } from '../utils/useDebouncedValue';

interface UserPickerProps {
  value: UserRef | null;
  onChange: (user: UserRef | null) => void;
  appearance?: ComboboxProps['appearance'];
  'aria-labelledby'?: string;
}

export function UserPicker({ value, onChange, ...rest }: UserPickerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(value?.displayName ?? '');
  const search = useDebouncedValue(text);
  const { data = [] } = useQuery({
    queryKey: ['identity', 'users', search],
    queryFn: async ({ signal }) =>
      (await api.get<UserSummary[]>(`/api/v1/identity/users${query({ search: search === value?.displayName ? '' : search })}`, signal)).data,
    staleTime: 60_000,
  });

  const options = value && !data.some((u) => u.id === value.id) ? [{ ...value, email: null, isActive: true }, ...data] : data;

  return (
    <Combobox
      clearable
      freeform={false}
      placeholder={t('userPicker.placeholder')}
      value={text}
      selectedOptions={value ? [value.id] : []}
      onInput={(event) => setText((event.target as HTMLInputElement).value)}
      onOptionSelect={(_, data) => {
        const selected = options.find((u) => u.id === data.optionValue) ?? null;
        onChange(selected ? { id: selected.id, displayName: selected.displayName } : null);
        setText(selected?.displayName ?? '');
      }}
      {...rest}
    >
      {options.map((user) => (
        <Option key={user.id} value={user.id} text={user.displayName}>
          {user.displayName}
          {user.email ? ` · ${user.email}` : ''}
        </Option>
      ))}
    </Combobox>
  );
}
