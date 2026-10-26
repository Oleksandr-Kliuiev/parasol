import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, DialogSurface, makeStyles, useRestoreFocusTarget } from '@fluentui/react-components';
import { Dialog } from '../../shared/components/Dialog';
import { Add20Regular, DocumentText16Regular, HourglassHalf16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { useContracts } from './api';
import { HourBankForm } from './ContractDialogs';
import { ContractList } from './ContractsPage';
import { HourBankList } from './HourBankList';

const useStyles = makeStyles({ stack: { display: 'flex', flexDirection: 'column', gap: '16px' } });

export function OrganizationContractsTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canWrite = useCan(Permissions.contractsWrite);
  const contracts = useContracts({ organizationId });
  const [addingBank, setAddingBank] = useState(false);
  const restoreFocusTarget = useRestoreFocusTarget();
  const rows = contracts.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className={styles.stack}>
      <Panel
        title={t('contracts.title')}
        icon={<DocumentText16Regular />}
        actions={
          canWrite && (
            <Button size="small" icon={<Add20Regular />} onClick={() => navigate(`/contracts/new?organizationId=${organizationId}`)}>
              {t('contracts.new')}
            </Button>
          )
        }
      >
        {contracts.error ? (
          <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
        ) : (
          <ContractList rows={rows} loading={contracts.isPending} empty={t('contracts.emptyForOrganization')} showOrganization={false} inPanel />
        )}
      </Panel>
      <Panel
        title={t('contracts.hourBanks.title')}
        icon={<HourglassHalf16Regular />}
        actions={
          canWrite && (
            <Button {...restoreFocusTarget} size="small" icon={<Add20Regular />} onClick={() => setAddingBank(true)}>
              {t('contracts.hourBanks.new')}
            </Button>
          )
        }
      >
        <HourBankList organizationId={organizationId} />
      </Panel>
      <Dialog open={addingBank} onOpenChange={(_, d) => !d.open && setAddingBank(false)}>
        <DialogSurface><HourBankForm organizationId={organizationId} contractId={null} onClose={() => setAddingBank(false)} /></DialogSurface>
      </Dialog>
    </div>
  );
}
