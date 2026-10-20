import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useQuoteTemplates, useSaveQuoteTemplate } from './api';
import type { QuoteTemplate } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: tokens.spacingHorizontalM },
  wide: { gridColumn: '1 / -1' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
});

/** The wording of the quote document, per language; a quote copies the texts when it is created (BR-SAL-06). */
export function QuoteTemplatesPage() {
  const styles = useStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const { data = [], error, isPending, refetch } = useQuoteTemplates(true);
  const [editing, setEditing] = useState<QuoteTemplate | 'new' | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <PageHeader
        title={t('quoteTemplates.title')}
        subtitle={t('quoteTemplates.subtitle')}
        actions={
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setEditing('new')}>
            {t('quoteTemplates.new')}
          </Button>
        }
      />

      {isPending ? (
        <Spinner label={t('common.loading')} />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState message={t('quoteTemplates.empty')} />
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('quoteTemplates.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('quoteTemplates.fields.name')}</TableHeaderCell>
                <TableHeaderCell>{t('quoteTemplates.fields.language')}</TableHeaderCell>
                <TableHeaderCell className={catalog.number}>{t('quoteTemplates.fields.validityDays')}</TableHeaderCell>
                <TableHeaderCell>{t('common.status')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <Text weight="semibold">{template.name}</Text>
                    <div className={styles.muted}>{template.introText}</div>
                  </TableCell>
                  <TableCell>{t(`quotes.languages.${template.language}`)}</TableCell>
                  <TableCell className={catalog.number}>{template.validityDays}</TableCell>
                  <TableCell>
                    {[
                      template.isDefault ? t('quoteTemplates.isDefault') : null,
                      template.isActive ? t('common.active') : t('common.inactive'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </TableCell>
                  <TableCell>
                    <Button
                      {...restoreFocusTarget}
                      appearance="subtle"
                      icon={<Edit20Regular />}
                      aria-label={t('quoteTemplates.editNamed', { name: template.name })}
                      onClick={() => setEditing(template)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      )}

      {editing && <TemplateDialog template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TemplateDialog({ template, onClose }: { template: QuoteTemplate | null; onClose: () => void }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const save = useSaveQuoteTemplate();
  const [name, setName] = useState(template?.name ?? '');
  const [language, setLanguage] = useState(template?.language ?? 'nb');
  const [introText, setIntroText] = useState(template?.introText ?? '');
  const [termsText, setTermsText] = useState(template?.termsText ?? '');
  const [footerText, setFooterText] = useState(template?.footerText ?? '');
  const [validityDays, setValidityDays] = useState(String(template?.validityDays ?? 30));
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  const [isActive, setIsActive] = useState(template?.isActive ?? true);

  const submit = async () => {
    try {
      await save.mutateAsync({
        id: template?.id,
        etag: template?.etag,
        name: name.trim(),
        language,
        introText: blankToNull(introText),
        termsText: blankToNull(termsText),
        footerText: blankToNull(footerText),
        validityDays: Number(validityDays) || 30,
        isDefault,
        isActive,
      });
      notify(t('quoteTemplates.saved'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{template ? t('quoteTemplates.editTitle') : t('quoteTemplates.new')}</DialogTitle>
          <DialogContent>
            <div className={styles.grid}>
              <Field label={t('quoteTemplates.fields.name')} required>
                <Input value={name} onChange={(_, d) => setName(d.value)} />
              </Field>
              <Field label={t('quoteTemplates.fields.language')}>
                <Dropdown
                  selectedOptions={[language]}
                  value={t(`quotes.languages.${language}`)}
                  onOptionSelect={(_, d) => setLanguage(d.optionValue ?? 'nb')}
                >
                  <Option value="nb">{t('quotes.languages.nb')}</Option>
                  <Option value="en">{t('quotes.languages.en')}</Option>
                </Dropdown>
              </Field>
              <Field label={t('quoteTemplates.fields.validityDays')}>
                <Input type="number" min={1} max={365} value={validityDays} onChange={(_, d) => setValidityDays(d.value)} />
              </Field>
              <Field label={t('quoteTemplates.fields.footerText')}>
                <Input value={footerText} onChange={(_, d) => setFooterText(d.value)} />
              </Field>
              <Field label={t('quoteTemplates.fields.introText')} className={styles.wide}>
                <Textarea rows={3} value={introText} onChange={(_, d) => setIntroText(d.value)} />
              </Field>
              <Field label={t('quoteTemplates.fields.termsText')} className={styles.wide}>
                <Textarea rows={4} value={termsText} onChange={(_, d) => setTermsText(d.value)} />
              </Field>
              <Switch
                label={t('quoteTemplates.isDefault')}
                checked={isDefault}
                onChange={(_, d) => setIsDefault(Boolean(d.checked))}
              />
              <Switch label={t('common.active')} checked={isActive} onChange={(_, d) => setIsActive(Boolean(d.checked))} />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button appearance="primary" disabled={save.isPending || name.trim() === ''} onClick={() => void submit()}>
              {t('common.save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
