import {
  Badge,
  Button,
  Link,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Attach16Regular, Open16Regular, Save20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDateTime } from '../../shared/utils/format';
import { useActivityActions, useCustomerMail, useOutlookStatus } from './api';
import type { MailMessage } from './types';
import { safeHttpUrl } from '../../shared/utils/safeUrl';

const useStyles = makeStyles({
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  item: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    paddingInline: tokens.spacingHorizontalM,
    paddingBlock: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  text: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, flexGrow: 1 },
  subject: { fontWeight: tokens.fontWeightSemibold },
  muted: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  note: { marginBottom: tokens.spacingVerticalM },
});

/**
 * The customer's correspondence, read live from the signed-in user's mailbox (FR-ACT-03). Nothing is copied into the CRM
 * until somebody saves a message, and even then only what is shown here — never the body (SEC-GDPR-06).
 */
export function OrganizationMailTab({ organizationId }: { organizationId: string }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const notify = useNotify();
  const canWrite = useCan(Permissions.activitiesWrite);
  const outlook = useOutlookStatus();
  const connected = outlook.data?.mail ?? false;
  const mail = useCustomerMail(organizationId, connected);
  const { error, isPending, refetch } = mail;
  const data = mail.data?.messages ?? [];
  const actions = useActivityActions();

  if (outlook.isPending) return <Spinner label={t('common.loading')} />;
  if (!connected) return <EmptyState message={t('mail.notConnected')} />;
  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const save = async (message: MailMessage) => {
    try {
      await actions.saveMail.mutateAsync({
        organizationId,
        opportunityId: null,
        contractId: null,
        contactId: null,
        messageId: message.messageId,
        subject: message.subject,
        preview: message.preview,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        receivedAt: message.receivedAt,
        webLink: message.webLink,
      });
      notify(t('mail.saved'));
      await refetch();
    } catch (e) {
      notify(t('errors.generic'), 'error', errorMessage(e, t));
    }
  };

  return (
    <Panel title={t('mail.title')}>
      <Text block className={`${styles.muted} ${styles.note}`}>
        {t('mail.explainer')}
      </Text>
      {mail.data && mail.data.notSearched > 0 && (
        <Text block className={`${styles.muted} ${styles.note}`}>
          {t('mail.partialSearch', { searched: mail.data.searched.join(', '), count: mail.data.notSearched })}
        </Text>
      )}
      {data.length === 0 ? (
        <EmptyState message={t('mail.empty')} />
      ) : (
        <ul className={styles.list}>
          {data.map((message) => (
            <li key={message.messageId} className={styles.item}>
              <span className={styles.text}>
                <span className={styles.subject}>
                  {message.webLink ? (
                    <Link href={safeHttpUrl(message.webLink)} target="_blank" rel="noopener noreferrer">
                      {message.subject}
                      <Open16Regular aria-hidden style={{ marginInlineStart: 4 }} />
                    </Link>
                  ) : (
                    message.subject
                  )}
                </span>
                <span className={styles.muted}>
                  {message.fromName ? `${message.fromName} · ` : ''}
                  {message.fromAddress} · {formatDateTime(message.receivedAt)}
                  {message.mailbox !== 'me' ? ` · ${message.mailbox}` : ''}
                </span>
                {message.preview && <span className={styles.muted}>{message.preview}</span>}
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {message.hasAttachments && (
                  <Badge appearance="outline" color="informative" icon={<Attach16Regular />}>
                    {t('mail.attachments')}
                  </Badge>
                )}
                {message.isSaved ? (
                  <Badge appearance="outline" color="success">
                    {t('mail.savedBadge')}
                  </Badge>
                ) : (
                  canWrite && (
                    <Button
                      size="small"
                      icon={<Save20Regular />}
                      disabled={actions.saveMail.isPending}
                      onClick={() => void save(message)}
                    >
                      {t('mail.save')}
                    </Button>
                  )
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
