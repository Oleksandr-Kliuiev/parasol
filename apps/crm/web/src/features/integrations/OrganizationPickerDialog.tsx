import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Button,
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
import { Dialog } from '../../shared/components/Dialog';
import { useTranslation } from 'react-i18next';
import { api, query } from '../../api/client';
import type { SearchResponse } from '../../api/types';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { h } from '../../app/hearth';
import { EmptyState } from '../../shared/components/EmptyState';
import { IconChip } from '../admin/IconChip';
import { Box16Regular, Box24Regular, Building16Regular, Building24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  search: { width: '100%', maxWidth: 'none' },
  // Hits as quiet rows of the visual system: an icon chip, the name over its detail line, the action on the right.
  list: { listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: '8px' },
  item: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: '12px',
    paddingTop: '10px',
    paddingBottom: '10px',
    paddingLeft: '12px',
    paddingRight: '12px',
    borderRadius: '14px',
    backgroundColor: h.well,
    minWidth: 0,
  },
  text: { display: 'grid', minWidth: 0 },
  name: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px', overflowWrap: 'anywhere' },
  muted: { color: h.muted, fontSize: '12.5px', lineHeight: '18px', overflowWrap: 'anywhere' },
  hint: { display: 'block', marginTop: '10px', color: h.muted, fontSize: '13px', lineHeight: '20px' },
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
  // The picker mounts with the surface, once per opening, and stays while the dialog leaves.
  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface><PickerBody group={group} initialSearch={initialSearch} onPick={onPick} onClose={onClose} /></DialogSurface>
    </Dialog>
  );
}

function PickerBody({ group = 'organizations', initialSearch, onPick, onClose }: Omit<OrganizationPickerDialogProps, 'open'>) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [text, setText] = useState(initialSearch);
  const term = useDebouncedValue(text.trim(), 250);
  const { data, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['search', 'picker', group, term],
    enabled: term.length >= 2,
    // While another search is read, the hits of the previous one stay, so the Link button under the pointer still takes the click.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => (await api.get<SearchResponse>(`/api/v1/search${query({ q: term, take: 10 })}`, signal)).data,
  });
  // Under two letters nothing is searched, and no hits of an earlier search stay under the hint.
  const organizations = term.length >= 2 ? (data?.groups.find((g) => g.group === group)?.items ?? []) : [];

  return (
    <DialogBody>
      <DialogTitle>{group === 'products' ? t('mappings.pickProductTitle') : t('mappings.pickTitle')}</DialogTitle>
      <DialogContent>
        <SearchBox
          className={styles.search}
          value={text}
          onChange={(_, d) => setText(d.value)}
          placeholder={t('mappings.pickSearch')}
          aria-label={t('mappings.pickSearch')}
          contentAfter={isFetching ? <Spinner size="extra-tiny" /> : undefined}
        />
        {term.length < 2 ? (
          <Text className={styles.hint}>{t('mappings.pickHint')}</Text>
        ) : (
          !isFetching && organizations.length === 0 && <EmptyState message={t('mappings.pickEmpty')} icon={group === 'products' ? <Box24Regular /> : <Building24Regular />} />
        )}
        <ul className={styles.list} aria-busy={isPlaceholderData || undefined}>
          {organizations.map((o) => (
            <li key={o.id} className={styles.item}>
              <IconChip icon={group === 'products' ? <Box16Regular /> : <Building16Regular />} tone={group === 'products' ? 'saffron' : 'iris'} small />
              <span className={styles.text}>
                <span className={styles.name}>{o.title}</span>
                {o.subtitle && <span className={styles.muted}>{o.subtitle}</span>}
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
