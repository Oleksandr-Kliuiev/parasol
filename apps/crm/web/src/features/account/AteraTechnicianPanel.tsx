import { Button, Spinner, Text, makeStyles } from '@fluentui/react-components';
import { PersonSupport16Regular, PersonSettings20Regular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useHref, useLinkClickHandler } from 'react-router';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { h } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { FactGrid, Panel } from '../../shared/components/Panel';

/** Whom one's ticket changes and hours are signed as in Atera: one's own technician, the shared one, or no one. */
interface MyAteraTechnician {
  enabled: boolean;
  technician: { id: string; name: string; email: string | null; userId: string | null; shared: boolean } | null;
}

const myAteraTechnicianKey = ['atera', 'technicians', 'me'] as const;

const TECHNICIANS = '/admin/technicians';

const useStyles = makeStyles({
  note: { display: 'block', color: h.muted, fontSize: '13px', lineHeight: '19px', maxWidth: '65ch' },
  facts: { marginBottom: '12px' },
});

/** The account page's Atera card; hidden while the CRM does not work with Atera, or when the answer cannot be read. */
export function AteraTechnicianPanel() {
  const styles = useStyles();
  const { t } = useTranslation();
  const canMap = useCan(Permissions.integrationsManage);
  const techniciansHref = useHref(TECHNICIANS);
  const openTechnicians = useLinkClickHandler<HTMLAnchorElement>(TECHNICIANS);
  const mine = useQuery({
    queryKey: myAteraTechnicianKey,
    queryFn: async ({ signal }) => (await api.get<MyAteraTechnician>('/api/v1/integrations/atera/technicians/me', signal)).data,
  });

  if (mine.isError || (mine.data && !mine.data.enabled)) return null;
  const technician = mine.data?.technician;

  return (
    <Panel
      title={t('account.atera.title')}
      icon={<PersonSupport16Regular />}
      actions={canMap && (
        <Button as="a" size="small" href={techniciansHref} icon={<PersonSettings20Regular />} onClick={openTechnicians}>
          {t('account.atera.manage')}
        </Button>
      )}
    >
      {!mine.data ? (
        <Spinner size="tiny" label={t('common.loading')} />
      ) : technician ? (
        <>
          <FactGrid
            className={styles.facts}
            items={[
              { label: t('account.atera.writesAs'), value: technician.name },
              { label: t('account.atera.kind'), value: t(technician.shared ? 'account.atera.shared' : 'account.atera.own') },
            ]}
          />
          <Text className={styles.note}>{t(technician.shared ? 'account.atera.sharedNote' : 'account.atera.ownNote')}</Text>
        </>
      ) : (
        <Text className={styles.note}>{t(canMap ? 'account.atera.noneManage' : 'account.atera.none')}</Text>
      )}
    </Panel>
  );
}
