import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, Input, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import type { RegistryOrganization } from '../../api/types';
import { Panel } from '../../shared/components/Panel';
import { RegistryStatusBadge } from '../../shared/components/StatusBadges';
import { formatAddress } from '../../shared/utils/format';
import { formatOrgNumber, looksLikeOrgNumber, normalizeOrgNumber } from '../../shared/utils/orgNumber';
import { useDebouncedValue } from '../../shared/utils/useDebouncedValue';
import { lookupRegistry, searchRegistry } from './api';

const useStyles = makeStyles({
  results: { listStyle: 'none', margin: `${tokens.spacingVerticalM} 0 0`, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  result: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    paddingInline: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  resultText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function RegistryLookup({ onSelect }: { onSelect: (organization: RegistryOrganization) => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const term = useDebouncedValue(text.trim(), 400);

  const { data, isFetching } = useQuery({
    queryKey: ['brreg', term],
    enabled: term.length >= 2,
    staleTime: 24 * 60 * 60_000,
    queryFn: async ({ signal }) => {
      if (looksLikeOrgNumber(term)) {
        const lookup = await lookupRegistry(normalizeOrgNumber(term), signal);
        return lookup.organization ? [lookup.organization] : [];
      }
      return searchRegistry(term, signal);
    },
  });

  return (
    <Panel title={t('organizations.form.registryTitle')}>
      <Field label={t('organizations.form.registrySearch')} hint={t('organizations.form.registryHint')}>
        <Input
          value={text}
          onChange={(_, d) => setText(d.value)}
          contentBefore={<Search20Regular />}
          contentAfter={isFetching ? <Spinner size="tiny" /> : undefined}
          autoComplete="off"
        />
      </Field>
      {term.length >= 2 && data && data.length === 0 && !isFetching && (
        <Text className={styles.muted} block style={{ marginTop: tokens.spacingVerticalS }}>
          {t('organizations.form.registryNoResults')}
        </Text>
      )}
      {data && data.length > 0 && (
        <ul className={styles.results}>
          {data.map((organization) => (
            <li key={organization.orgNumber} className={styles.result}>
              <div className={styles.resultText}>
                <Text weight="semibold">{organization.name}</Text>
                <Text size={200} className={styles.muted}>
                  <span className="tabular">{formatOrgNumber(organization.orgNumber)}</span>
                  {organization.legalForm ? ` · ${organization.legalForm}` : ''}
                  {organization.businessAddress ? ` · ${formatAddress(organization.businessAddress)}` : ''}
                </Text>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <RegistryStatusBadge status={organization.status} />
                <Button size="small" onClick={() => onSelect(organization)}>
                  {t('organizations.form.useRegistryEntry')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
