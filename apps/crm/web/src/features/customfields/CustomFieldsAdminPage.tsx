import { useState } from 'react';
import {
  Badge,
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
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Textarea,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { Add20Regular, Delete20Regular, Edit20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { PageHeader } from '../../shared/components/PageHeader';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { blankToNull } from '../../shared/utils/format';
import { useCatalogStyles } from '../catalog/styles';
import { useDialogStyles } from '../contracts/dialogStyles';
import { useCustomFieldActions, useCustomFieldDefinitions } from './api';
import { customFieldEntities, customFieldTypes, type CustomFieldDefinition, type CustomFieldEntity, type CustomFieldType } from './types';
import { ScrollTable } from '../../shared/components/ScrollTable';

/** Fields a company adds to its records without a code change (FR-ADM-04). */
export function CustomFieldsAdminPage() {
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const { data = [], error, isPending, refetch } = useCustomFieldDefinitions(undefined, true);
  const actions = useCustomFieldActions();
  const [editing, setEditing] = useState<CustomFieldDefinition | 'new' | null>(null);
  const restoreFocusTarget = useRestoreFocusTarget();

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      notify(success);
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <>
      <PageHeader
        title={t('customFields.title')}
        subtitle={t('customFields.subtitle')}
        actions={
          <Button {...restoreFocusTarget} appearance="primary" icon={<Add20Regular />} onClick={() => setEditing('new')}>
            {t('customFields.new')}
          </Button>
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <ScrollTable className={catalog.tableWrap}>
          <Table className={catalog.table} aria-label={t('customFields.title')}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('customFields.fields.label')}</TableHeaderCell>
                <TableHeaderCell>{t('customFields.fields.entity')}</TableHeaderCell>
                <TableHeaderCell>{t('customFields.fields.type')}</TableHeaderCell>
                <TableHeaderCell>{t('customFields.fields.required')}</TableHeaderCell>
                <TableHeaderCell>{t('customFields.fields.status')}</TableHeaderCell>
                <TableHeaderCell />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((field) => (
                <TableRow key={field.id}>
                  <TableCell>
                    <span className={catalog.name}>{field.label}</span>
                    <div className={catalog.sku}>{field.key}</div>
                  </TableCell>
                  <TableCell>{t(`customFields.entities.${field.entity}`)}</TableCell>
                  <TableCell>
                    {t(`customFields.types.${field.type}`)}
                    {field.type === 'Select' && <div className={catalog.sku}>{field.options.join(', ')}</div>}
                  </TableCell>
                  <TableCell>{field.required ? t('common.yes') : t('common.no')}</TableCell>
                  <TableCell>
                    <Badge appearance="outline" color={field.isActive ? 'success' : 'subtle'}>
                      {field.isActive ? t('customFields.active') : t('customFields.inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button icon={<Edit20Regular />} appearance="subtle" aria-label={t('common.edit')} onClick={() => setEditing(field)} />
                    <Button
                      appearance="subtle"
                      onClick={() => void run(() => actions.setActive.mutateAsync({ id: field.id, active: !field.isActive }), t('customFields.saved'))}
                    >
                      {field.isActive ? t('customFields.deactivate') : t('customFields.activate')}
                    </Button>
                    <Button
                      icon={<Delete20Regular />}
                      appearance="subtle"
                      aria-label={t('common.delete')}
                      onClick={() => void run(() => actions.remove.mutateAsync(field.id), t('customFields.deleted'))}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!isPending && data.length === 0 && <EmptyState message={t('customFields.empty')} />}
        </ScrollTable>
      )}

      <Dialog open={editing !== null} onOpenChange={(_, d) => !d.open && setEditing(null)}>
        <DialogSurface>
          {editing !== null && <FieldForm field={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function FieldForm({ field, onClose }: { field?: CustomFieldDefinition; onClose: () => void }) {
  const styles = useDialogStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const actions = useCustomFieldActions();
  const [entity, setEntity] = useState<CustomFieldEntity>(field?.entity ?? 'Organization');
  const [label, setLabel] = useState(field?.label ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'Text');
  const [options, setOptions] = useState((field?.options ?? []).join('\n'));
  const [required, setRequired] = useState(field?.required ?? false);
  const [order, setOrder] = useState(String(field?.order ?? 1));
  const [hint, setHint] = useState(field?.hint ?? '');
  const invalid = !label.trim() || !(key.trim() || label.trim()) || (type === 'Select' && options.trim() === '');

  const submit = async () => {
    if (invalid) return;
    try {
      await actions.save.mutateAsync({
        id: field?.id,
        request: {
          entity,
          key: (key.trim() || label.trim()),
          label: label.trim(),
          type,
          options: options.split('\n').map((o) => o.trim()).filter(Boolean),
          required,
          order: Number(order) || 0,
          hint: blankToNull(hint),
        },
      });
      notify(t('customFields.saved'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{field ? t('customFields.editTitle') : t('customFields.newTitle')}</DialogTitle>
        <DialogContent>
          <div className={styles.grid}>
            <Field label={t('customFields.fields.entity')} required>
              <Dropdown
                value={t(`customFields.entities.${entity}`)}
                selectedOptions={[entity]}
                disabled={Boolean(field)}
                onOptionSelect={(_, d) => setEntity(d.optionValue as CustomFieldEntity)}
              >
                {customFieldEntities.map((value) => (
                  <Option key={value} value={value}>
                    {t(`customFields.entities.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('customFields.fields.type')} required>
              <Dropdown
                value={t(`customFields.types.${type}`)}
                selectedOptions={[type]}
                onOptionSelect={(_, d) => setType(d.optionValue as CustomFieldType)}
              >
                {customFieldTypes.map((value) => (
                  <Option key={value} value={value}>
                    {t(`customFields.types.${value}`)}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label={t('customFields.fields.label')} required className={styles.wide}>
              <Input value={label} onChange={(_, d) => setLabel(d.value)} />
            </Field>
            <Field label={t('customFields.fields.key')} hint={t('customFields.keyHint')}>
              <Input value={key} onChange={(_, d) => setKey(d.value)} disabled={Boolean(field)} />
            </Field>
            <Field label={t('customFields.fields.order')}>
              <Input inputMode="numeric" value={order} onChange={(_, d) => setOrder(d.value)} />
            </Field>
            {type === 'Select' && (
              <Field label={t('customFields.fields.options')} hint={t('customFields.optionsHint')} className={styles.wide} required>
                <Textarea value={options} onChange={(_, d) => setOptions(d.value)} resize="vertical" rows={4} />
              </Field>
            )}
            <Field label={t('customFields.fields.hint')} className={styles.wide}>
              <Input value={hint} onChange={(_, d) => setHint(d.value)} />
            </Field>
            <div className={styles.wide}>
              <Switch label={t('customFields.fields.required')} checked={required} onChange={(_, d) => setRequired(Boolean(d.checked))} />
            </div>
          </div>
          {actions.save.error && (
            <MessageBar intent="error" style={{ marginTop: 12 }}>
              <MessageBarBody>{errorMessage(actions.save.error, t)}</MessageBarBody>
            </MessageBar>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={invalid || actions.save.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
