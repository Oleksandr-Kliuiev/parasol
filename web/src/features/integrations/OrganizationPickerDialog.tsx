import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  SearchBox,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { SearchResponse } from '../../api/types';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: `${tokens.spacingVerticalM} 0 0`, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  item: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

interface OrganizationPickerDialogProps {
  open: boolean;
  /** Search group to pick from; products use the catalog search provider. */
  group?: 'organizations' | 'products';
  initialSearch: string;
  onPick: (organization: { id: string; name: string }) => void;
  onClose: () => void;
}

export function OrganizationPickerDialog({ open, group = 'organizations', initialSearch, onPick, onClose }: OrganizationPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>{open && <PickerBody group={group} initialSearch={initialSearch} onPick={onPick} onClose={onClose} />}</DialogSurface>
    </Dialog>
  );
}

function PickerBody({ group = 'organizations', initialSearch, onPick, onClose }: Omit<OrganizationPickerDialogProps, 'open'>) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [text, setText] = useState(initialSearch);
  const term = useDebouncedValue(text.trim(), 250);
  const { data, isFetching } = useQuery({
    queryKey: ['search', 'picker', group, term],
    enabled: term.length >= 2,
    queryFn: async ({ signal }) => (await api.get<SearchResponse>(`/api/v1/search${query({ q: term, take: 10 })}`, signal)).data,
  });
  const organizations = data?.groups.find((g) => g.group === group)?.items ?? [];

  return (
    <DialogBody>
      <DialogTitle>{group === 'products' ? t('mappings.pickProductTitle') : t('mappings.pickTitle')}</DialogTitle>
      <DialogContent>
        <SearchBox
          value={text}
          onChange={(_, d) => setText(d.value)}
          placeholder={t('mappings.pickSearch')}
          aria-label={t('mappings.pickSearch')}
          contentAfter={isFetching ? <Spinner size="extra-tiny" /> : undefined}
          style={{ width: '100%', maxWidth: 'none' }}
        />
        <ul className={styles.list}>
          {organizations.map((o) => (
            <li key={o.id} className={styles.item}>
              <span>
                <Text weight="semibold" block>
                  {o.title}
                </Text>
                {o.subtitle && (
                  <Text size={200} className={styles.muted}>
                    {o.subtitle}
                  </Text>
                )}
              </span>
              <Button size="small" onClick={() => onPick({ id: o.id, name: o.title })}>
                {t('mappings.link')}
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </DialogBody>
  );
}
