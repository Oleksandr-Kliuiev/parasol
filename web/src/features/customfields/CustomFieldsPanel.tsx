import { useState } from 'react';
import { Button, Field, Input, MessageBar, MessageBarBody, Select, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { useCustomFieldValues, useSaveCustomFieldValues } from './api';
import type { CustomFieldEntity, CustomFieldValue } from './types';

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}` },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalM },
});

/** The company's own fields on a record (FR-ADM-04). Renders nothing when nobody has defined any. */
export function CustomFieldsPanel({ entity, entityId }: { entity: CustomFieldEntity; entityId: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canEdit = useCan(Permissions.customersWrite);
  const { data = [], isPending } = useCustomFieldValues(entity, entityId);
  const save = useSaveCustomFieldValues(entity, entityId);
  // Only what the user typed lives in state; everything else is read from the server's answer.
  const [edits, setEdits] = useState<Record<string, string>>({});

  if (isPending || data.length === 0) return null;

  const valueOf = (key: string, stored: string | null) => edits[key] ?? stored ?? '';
  const dirty = data.some((field) => field.key in edits && edits[field.key] !== (field.value ?? ''));

  const submit = async () => {
    try {
      await save.mutateAsync(Object.fromEntries(data.map((field) => [field.key, valueOf(field.key, field.value).trim() || null])));
      setEdits({});
      notify(t('customFields.saved'));
    } catch (e) {
      notify(t('customFields.failed'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className={styles.grid}>
        {data.map((field) => (
          <CustomFieldInput
            key={field.definitionId}
            field={field}
            value={valueOf(field.key, field.value)}
            disabled={!canEdit}
            onChange={(value) => setEdits((current) => ({ ...current, [field.key]: value }))}
          />
        ))}
      </div>
      {save.error && (
        <MessageBar intent="error" style={{ marginTop: 12 }}>
          <MessageBarBody>{errorMessage(save.error, t)}</MessageBarBody>
        </MessageBar>
      )}
      {canEdit && (
        <div className={styles.actions}>
          <Button appearance="primary" type="submit" disabled={!dirty || save.isPending}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </form>
  );
}

function CustomFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: CustomFieldValue;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const hint = field.hint ?? undefined;

  if (field.type === 'Boolean') {
    return (
      <Field label={field.label} hint={hint}>
        <Switch
          checked={value === 'true'}
          disabled={disabled}
          onChange={(_, d) => onChange(d.checked ? 'true' : 'false')}
          label={value === 'true' ? t('common.yes') : t('common.no')}
        />
      </Field>
    );
  }

  if (field.type === 'Select') {
    return (
      <Field label={field.label} hint={hint} required={field.required}>
        <Select value={value} disabled={disabled} onChange={(_, d) => onChange(d.value)}>
          <option value="">{t('customFields.noValue')}</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field label={field.label} hint={hint} required={field.required}>
      <Input
        type={field.type === 'Date' ? 'date' : 'text'}
        inputMode={field.type === 'Number' ? 'decimal' : undefined}
        value={value}
        disabled={disabled}
        onChange={(_, d) => onChange(d.value)}
      />
    </Field>
  );
}
