import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  Switch,
  Text,
  makeStyles,
  tokens,
  useRestoreFocusTarget,
} from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import type { Organization } from '../../api/types';
import { OrganizationPicker } from '../contracts/OrganizationPicker';
import type { Ref } from '../contracts/types';
import { useSetOrganizationParent } from './api';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  actions: { marginTop: tokens.spacingVerticalS },
});

/** The group a customer belongs to, and whether its invoice goes to the parent (FR-CUS-07). */
export function OrganizationGroupPanel({ organization, etag }: { organization: Organization; etag: string | null }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const canEdit = useCan(Permissions.customersWrite);
  const [editing, setEditing] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();

  return (
    <>
      <div className={styles.list}>
        {organization.parent ? (
          <div className={styles.row}>
            <Text>{t('organizations.group.parent')}:</Text>
            <AppLink to={`/organizations/${organization.parent.id}`}>{organization.parent.name}</AppLink>
            <Text className={styles.muted}>
              {organization.billedThroughParent ? t('organizations.group.billedThroughParent') : t('organizations.group.billedItself')}
            </Text>
          </div>
        ) : (
          <Text className={styles.muted}>{t('organizations.group.noParent')}</Text>
        )}

        {organization.children.length > 0 && (
          <>
            <Text>{t('organizations.group.subsidiaries', { count: organization.children.length })}</Text>
            {organization.children.map((child) => (
              <div key={child.id} className={styles.row}>
                <AppLink to={`/organizations/${child.id}`}>{child.name}</AppLink>
                <Text className={styles.muted}>
                  {child.billedThroughParent ? t('organizations.group.onOurInvoice') : t('organizations.group.ownInvoice')}
                </Text>
              </div>
            ))}
          </>
        )}
      </div>

      {canEdit && (
        <div className={styles.actions}>
          <Button {...restoreFocusTarget} appearance="subtle" size="small" onClick={() => setEditing(true)}>
            {organization.parent ? t('organizations.group.change') : t('organizations.group.add')}
          </Button>
        </div>
      )}

      <Dialog open={editing} onOpenChange={(_, d) => !d.open && setEditing(false)}>
        <DialogSurface>
          {editing && <GroupForm organization={organization} etag={etag} onClose={() => setEditing(false)} />}
        </DialogSurface>
      </Dialog>
    </>
  );
}

function GroupForm({ organization, etag, onClose }: { organization: Organization; etag: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const setParent = useSetOrganizationParent(organization.id);
  const [parent, setParentRef] = useState<Ref | null>(
    organization.parent ? { id: organization.parent.id, name: organization.parent.name } : null,
  );
  const [billedThroughParent, setBilled] = useState(organization.billedThroughParent);

  const submit = async () => {
    try {
      await setParent.mutateAsync({ request: { parentId: parent?.id ?? null, billedThroughParent }, etag });
      notify(t('organizations.group.saved'));
      onClose();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <DialogBody>
        <DialogTitle>{t('organizations.group.title')}</DialogTitle>
        <DialogContent>
          <p style={{ marginTop: 0 }}>{t('organizations.group.body')}</p>
          <Field label={t('organizations.group.parent')}>
            <OrganizationPicker value={parent} onChange={setParentRef} />
          </Field>
          <div style={{ marginTop: 12 }}>
            <Switch
              label={t('organizations.group.billThroughParent')}
              checked={billedThroughParent}
              disabled={!parent}
              onChange={(_, d) => setBilled(Boolean(d.checked))}
            />
          </div>
          {parent && billedThroughParent && (
            <MessageBar intent="info" style={{ marginTop: 12 }}>
              <MessageBarBody>{t('organizations.group.billingHint', { name: parent.name })}</MessageBarBody>
            </MessageBar>
          )}
          {setParent.error && (
            <MessageBar intent="error" style={{ marginTop: 12 }}>
              <MessageBarBody>{errorMessage(setParent.error, t)}</MessageBarBody>
            </MessageBar>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" type="submit" disabled={setParent.isPending}>
            {t('common.save')}
          </Button>
        </DialogActions>
      </DialogBody>
    </form>
  );
}
