import { useState } from 'react';
import { Combobox, Option } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import type { ProductListItem, ProductPage } from './types';

interface ProductPickerProps {
  /** Only the identity and the label are read, so a caller may keep a smaller object. */
  value: Pick<ProductListItem, 'id' | 'sku' | 'name'> | null;
  onChange: (product: ProductListItem | null) => void;
  /** Products that cannot be picked, e.g. already in the price list. */
  exclude?: string[];
  id?: string;
}

/** Searches active products by name or SKU. */
export function ProductPicker({ value, onChange, exclude = [], id }: ProductPickerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(value ? `${value.sku} ${value.name}` : '');
  const search = useDebouncedValue(text);
  const selectedText = value ? `${value.sku} ${value.name}` : '';
  const { data } = useQuery({
    queryKey: ['catalog', 'picker', search === selectedText ? '' : search],
    queryFn: async ({ signal }) =>
      (await api.get<ProductPage>(`/api/v1/catalog/products${query({ search: search === selectedText ? '' : search, active: true, limit: 20 })}`, signal)).data,
    staleTime: 30_000,
  });
  const options = (data?.items ?? []).filter((p) => !exclude.includes(p.id));

  return (
    <Combobox
      id={id}
      freeform={false}
      clearable
      placeholder={t('catalog.picker.placeholder')}
      value={text}
      selectedOptions={value ? [value.id] : []}
      onInput={(event) => setText((event.target as HTMLInputElement).value)}
      onOptionSelect={(_, d) => {
        const selected = options.find((p) => p.id === d.optionValue) ?? null;
        onChange(selected);
        setText(selected ? `${selected.sku} ${selected.name}` : '');
      }}
    >
      {options.length === 0 && (
        <Option key="none" value="" disabled text="">
          {t('catalog.picker.none')}
        </Option>
      )}
      {options.map((p) => (
        <Option key={p.id} value={p.id} text={`${p.sku} ${p.name}`}>
          {p.sku} · {p.name}
        </Option>
      ))}
    </Combobox>
  );
}
