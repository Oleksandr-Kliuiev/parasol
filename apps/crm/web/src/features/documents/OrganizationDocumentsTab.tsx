import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { useHref, useLinkClickHandler } from 'react-router';
import {
  Button,
  Link,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  ArrowEnter20Regular,
  CloudOff20Regular,
  Document20Regular,
  Folder16Regular,
  Folder20Regular,
  Folder24Regular,
  FolderAdd20Regular,
  FolderLink20Regular,
  FolderProhibited20Regular,
  FolderProhibited24Regular,
  LinkDismiss20Regular,
  LockClosed20Regular,
  Open16Regular,
  PlugDisconnected20Regular,
} from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { loginUrl } from '../../api/client';
import { h, type Tone } from '../../app/hearth';
import { Permissions, useCan } from '../../auth/CurrentUserContext';
import { AppLink } from '../../shared/components/AppLink';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { EmptyState } from '../../shared/components/EmptyState';
import { ErrorState } from '../../shared/components/ErrorState';
import { Panel } from '../../shared/components/Panel';
import { ScrollTable } from '../../shared/components/ScrollTable';
import { useNotify } from '../../shared/components/useNotify';
import { errorMessage } from '../../shared/utils/errors';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { safeHttpUrl } from '../../shared/utils/safeUrl';
import { NARROW_SCREEN, useMediaQuery } from '../../shared/utils/useMediaQuery';
import { ActionDialog } from '../actions/ActionDialog';
import { useActionOffer } from '../actions/api';
import { IconChip, PersonCell, useSettingsStyles } from '../admin/settingsUi';
import { useCatalogStyles } from '../catalog/styles';
import { createFolderRequest, folderMappingsPath, useOrganizationDocuments, useRemoveFolderLink } from './api';
import { StoredReports } from './StoredReports';
import { fileSize } from './storedFiles';
import type { DocumentFolderState, DocumentItem, OrganizationDocuments } from './types';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  // The customer's folder as a row of the integrations reference: chip, name and where it lives, the link on the right.
  head: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: '12px',
    rowGap: '8px',
    marginBottom: '16px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '12px',
    paddingRight: '16px',
    borderRadius: '14px',
    backgroundColor: h.well,
    minWidth: 0,
  },
  // A state without a listing is the whole panel: the chip beside the first line, the words and the ways on under it.
  stateHead: { flexWrap: 'nowrap', alignItems: 'flex-start', marginBottom: 0 },
  stateBody: { display: 'grid', gap: '4px', minWidth: 0, flex: '1 1 0', maxWidth: '72ch', paddingTop: '8px', overflowWrap: 'anywhere' },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: '8px', rowGap: '8px', marginTop: '8px' },
  folder: { display: 'grid', gap: '2px', minWidth: 0, flex: '1 1 200px', overflowWrap: 'anywhere' },
  folderName: { fontWeight: tokens.fontWeightSemibold, fontSize: '14px', lineHeight: '20px' },
  link: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '32px', fontWeight: tokens.fontWeightSemibold },
  table: { minWidth: '560px' },
  sizeHead: { '& .fui-TableHeaderCell__button': { justifyContent: 'flex-end' } },
  name: { display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, overflowWrap: 'anywhere' },
  // The name and the mark of a new tab in one row: the mark beside the middle of the name, also when a long name wraps.
  fileLink: { display: 'inline-flex', alignItems: 'center', gap: '4px', minHeight: '24px', minWidth: 0, fontWeight: tokens.fontWeightSemibold },
  fileName: { minWidth: 0, overflowWrap: 'anywhere' },
  fileIcon: { flexShrink: 0 },
  muted: { color: h.muted, fontSize: '13px', fontVariantNumeric: 'tabular-nums' },
  // On a phone the table would show the names alone: each item is a row of the list, its facts on a line under the name.
  list: { listStyleType: 'none', margin: 0, padding: 0, border: `1px solid ${h.line}`, borderRadius: '14px', overflow: 'hidden' },
  row: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    paddingTop: '12px',
    paddingBottom: '12px',
    paddingLeft: '14px',
    paddingRight: '14px',
    borderTop: `1px solid ${h.line}`,
    ':first-child': { borderTop: 'none' },
  },
  rowMain: { display: 'grid', gap: '2px', minWidth: 0, flex: '1 1 0' },
  rowFacts: { color: h.muted, fontSize: '13px', lineHeight: '18px', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
});

/**
 * The customer's documents: the folder in SharePoint, which the CRM shows and links into (FR-DOC-01), and the monthly reports the CRM
 * files itself (M43). The reports describe the customer's IT, so they are shown to those who may also see the Drift tab.
 */
export function OrganizationDocumentsTab({ organizationId, organizationName }: { organizationId: string; organizationName?: string }) {
  const styles = useStyles();
  const canCustomers = useCan(Permissions.customersRead);
  const canService = useCan(Permissions.serviceRead);
  const canReports = canCustomers && canService;
  return (
    <div className={styles.stack}>
      <SharePointDocuments organizationId={organizationId} organizationName={organizationName} />
      {canReports && <StoredReports organizationId={organizationId} />}
    </div>
  );
}

/**
 * The customer's folder in SharePoint, read with the person's own access (FR-DOC-01, M47). Every way the read can end has words of its
 * own, so a folder that could not be read never looks absent. Making or linking a folder, and taking a stale link off, belong to those
 * who manage the integrations: the folder is made by the vendor action that a preview confirms, never by a click on its own.
 */
function SharePointDocuments({ organizationId, organizationName }: { organizationId: string; organizationName?: string }) {
  const { t } = useTranslation();
  const notify = useNotify();
  const canManage = useCan(Permissions.integrationsManage);
  const { data, error, isPending, isFetching, refetch } = useOrganizationDocuments(organizationId);
  // Offered only where a preview would let it through: the right, SharePoint's write switch and the kind switched on.
  const createOffer = useActionOffer('graph', 'folder.create', canManage && data?.state === 'NoFolder');
  // The state the folder was asked for in, while the confirmation is open.
  const [creating, setCreating] = useState<DocumentFolderState | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const unlink = useRemoveFolderLink(organizationId);
  const mappings = folderMappingsPath(organizationName);
  // A person's action here can change what the panel shows, and the control they used goes with the state it belonged to: the words
  // of the new state take the focus (WCAG 2.4.3), so it is not lost on the page and a screen reader says what is there now. A closing
  // dialog keeps the focus until its exit has played, so the heading waits for the page to have it back.
  const heading = useRef<HTMLSpanElement>(null);
  const [focusAsked, setFocusAsked] = useState(0);
  useEffect(() => {
    if (focusAsked === 0) return;
    let frames = 0;
    let frame = requestAnimationFrame(function attempt() {
      const active = document.activeElement;
      if (active && active !== document.body && active.closest('[role="dialog"], [role="alertdialog"]') && frames++ < 60) {
        frame = requestAnimationFrame(attempt);
        return;
      }
      heading.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusAsked]);
  const focusHeading = () => setFocusAsked((count) => count + 1);
  // A dialog closed while the folder is still being read again: the heading takes the focus once the new state is there.
  const focusOnNextState = useRef(false);
  const shownState = data?.state;
  useEffect(() => {
    if (!focusOnNextState.current) return;
    focusOnNextState.current = false;
    setFocusAsked((count) => count + 1);
  }, [shownState]);

  if (isPending) return <Spinner label={t('common.loading')} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const removeLink = async (linkId: string) => {
    try {
      // Settles once the folder was read again, so the new state is there when the dialog closes.
      await unlink.mutateAsync(linkId);
      setUnlinking(false);
      notify(t('documents.unlinked'));
      focusHeading();
    } catch {
      // The dialog stays open and says why.
    }
  };

  return (
    <Panel title={t('documents.title')} icon={<Folder16Regular />}>
      {!data.available ? (
        // One picture for one state: the empty state's own icon says it.
        <EmptyState icon={<FolderProhibited24Regular />} message={t('documents.notConfigured')} />
      ) : data.state === 'Ready' && data.folder ? (
        <FolderListing documents={data} heading={heading} />
      ) : (
        <FolderState
          documents={data}
          heading={heading}
          mappings={mappings}
          canManage={canManage}
          createOffer={createOffer}
          retrying={isFetching}
          onCreate={() => setCreating(data.state)}
          onUnlink={() => setUnlinking(true)}
          onRetry={() => void refetch().then(focusHeading)}
        />
      )}
      {/* Outside the states: the folder appears while the dialog still follows the action, and the dialog must stay. */}
      <ActionDialog
        request={creating !== null ? createFolderRequest(organizationId) : null}
        title={t('documents.createFolderTitle')}
        confirm={t('documents.createFolder')}
        details={
          // A folder named another way is not found by the server: the way to link it is offered before anything is made.
          <Text block>
            {t('documents.linkInstead')} <AppLink to={mappings}>{t('documents.linkExisting')}</AppLink>
          </Text>
        }
        onClose={() => {
          if (creating !== null && creating !== data.state) focusHeading();
          else if (creating !== null && isFetching) focusOnNextState.current = true;
          setCreating(null);
        }}
        onFinished={() => void refetch()}
      />
      <ConfirmDialog
        open={unlinking && data.linkId !== null}
        title={t('documents.unlinkTitle')}
        confirm={t('documents.unlink')}
        cancel={t('documents.keepLink')}
        busy={unlink.isPending}
        error={unlink.error ? errorMessage(unlink.error, t) : null}
        onConfirm={() => data.linkId && void removeLink(data.linkId)}
        onCancel={() => {
          setUnlinking(false);
          unlink.reset();
        }}
      >
        <Text block>{t('documents.unlinkBody')}</Text>
      </ConfirmDialog>
    </Panel>
  );
}

/** A folder that was read: its name and the way to SharePoint, then what is in it (folders first). */
function FolderListing({ documents, heading }: { documents: OrganizationDocuments; heading: RefObject<HTMLSpanElement | null> }) {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const catalog = useCatalogStyles();
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_SCREEN);
  const folder = documents.folder!;
  return (
    <>
      <div className={styles.head}>
        <IconChip icon={<Folder20Regular />} tone="saffron" />
        <span className={styles.folder}>
          <Text ref={heading} tabIndex={-1} className={styles.folderName}>{folder.name}</Text>
          {/* No silent cut: the rest is in SharePoint, and the way there is beside these words. */}
          {documents.more && <Text className={settings.note}>{t('documents.more', { count: documents.items.length })}</Text>}
        </span>
        <Link
          className={styles.link}
          href={safeHttpUrl(folder.webUrl)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${t('documents.openInSharePoint')} ${t('nav.opensNewTab')}`}
        >
          {t('documents.openInSharePoint')}
          <Open16Regular aria-hidden />
        </Link>
      </div>

      {documents.items.length === 0 ? (
        <EmptyState icon={<Folder24Regular />} message={t('documents.empty')} />
      ) : narrow ? (
        <ul className={styles.list} aria-label={t('documents.title')}>
          {documents.items.map((item) => (
            <li key={item.id} className={styles.row}>
              <ItemChip item={item} />
              <span className={styles.rowMain}>
                <ItemLink item={item} />
                <span className={styles.rowFacts}>
                  {[item.size === null ? null : fileSize(item.size), item.modifiedBy, item.modifiedAt ? formatDate(item.modifiedAt) : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ScrollTable>
          <Table aria-label={t('documents.title')} className={styles.table}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>{t('documents.fields.name')}</TableHeaderCell>
                <TableHeaderCell className={mergeClasses(catalog.number, styles.sizeHead)}>{t('documents.fields.size')}</TableHeaderCell>
                <TableHeaderCell>{t('documents.fields.modified')}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <span className={styles.name}>
                      <ItemChip item={item} />
                      <ItemLink item={item} />
                    </span>
                  </TableCell>
                  <TableCell className={mergeClasses(catalog.number, styles.muted)}>{item.size === null ? '—' : fileSize(item.size)}</TableCell>
                  <TableCell>
                    {item.modifiedBy ? (
                      <PersonCell name={item.modifiedBy} detail={item.modifiedAt ? formatDateTime(item.modifiedAt) : undefined} size={28} />
                    ) : (
                      <span className={styles.muted}>{item.modifiedAt ? formatDateTime(item.modifiedAt) : '—'}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollTable>
      )}
    </>
  );
}

function ItemChip({ item }: { item: DocumentItem }) {
  return <IconChip icon={item.isFolder ? <Folder20Regular /> : <Document20Regular />} tone={item.isFolder ? 'saffron' : 'iris'} small />;
}

/**
 * An item opens in SharePoint in a new tab; whether it is a folder, and the new tab, are said as well as shown (WCAG 1.3.1). The name
 * starts with the words on screen (WCAG 2.5.3).
 */
function ItemLink({ item }: { item: DocumentItem }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const name = item.isFolder ? `${item.name}, ${t('documents.folderKind')}` : item.name;
  return (
    <Link
      className={styles.fileLink}
      href={safeHttpUrl(item.webUrl)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} ${t('nav.opensNewTab')}`}
    >
      <span className={styles.fileName}>{item.name}</span>
      <Open16Regular aria-hidden className={styles.fileIcon} />
    </Link>
  );
}

/** A way to another page that weighs as much as the button beside it, and is still a link. */
function LinkButton({ to, icon, children }: { to: string; icon: ReactElement; children: ReactNode }) {
  const href = useHref(to);
  const open = useLinkClickHandler<HTMLAnchorElement>(to);
  return (
    <Button as="a" href={href} icon={icon} onClick={open}>
      {children}
    </Button>
  );
}

/** Why there is no listing, and the way on that this person has: link or make a folder, take a stale link off, sign in, read again. */
function FolderState({ documents, heading, mappings, canManage, createOffer, retrying, onCreate, onUnlink, onRetry }: {
  documents: OrganizationDocuments;
  heading: RefObject<HTMLSpanElement | null>;
  /** The SharePoint folders on the mapping screen, searched for the customer's name. */
  mappings: string;
  canManage: boolean;
  /** Whether the folder may be made from here; undefined while that is read, and the words on the ways wait for it. */
  createOffer: boolean | undefined;
  retrying: boolean;
  onCreate: () => void; onUnlink: () => void; onRetry: () => void;
}) {
  const styles = useStyles();
  const settings = useSettingsStyles();
  const { t } = useTranslation();
  const view = ((): { icon: ReactElement; tone: Tone; title: string; hint?: string; actions?: ReactNode } => {
    switch (documents.state) {
      case 'Gone':
        return {
          icon: <FolderProhibited20Regular />, tone: 'ember', title: t('documents.gone'),
          hint: canManage ? undefined : t('documents.goneAskHint'),
          actions: canManage && documents.linkId && <Button icon={<LinkDismiss20Regular />} onClick={onUnlink}>{t('documents.unlink')}</Button>,
        };
      case 'NoAccess':
        return { icon: <LockClosed20Regular />, tone: 'saffron', title: t('documents.noAccess'), hint: t('documents.noAccessHint') };
      case 'NotConnected':
        return {
          icon: <PlugDisconnected20Regular />, tone: 'saffron', title: t('documents.notConnected'), hint: t('documents.notConnectedHint'),
          // A new sign-in fetches a new token for the files; it leaves this page and comes back to it.
          actions: <Button as="a" href={loginUrl()} icon={<ArrowEnter20Regular />}>{t('documents.signInAgain')}</Button>,
        };
      case 'Unavailable':
        return {
          icon: <CloudOff20Regular />, tone: 'saffron', title: t('documents.unavailable'),
          // Focusable while it reads, so the focus stays on it until the answer takes it to the words.
          actions: <Button icon={<ArrowClockwise20Regular />} disabledFocusable={retrying} onClick={onRetry}>{t('common.retry')}</Button>,
        };
      default:
        return {
          icon: <FolderAdd20Regular />, tone: 'neutral', title: t('documents.noFolder'),
          hint: !canManage ? t('documents.noFolderAskHint')
            : createOffer === undefined ? undefined
              : t(createOffer ? 'documents.noFolderHint' : 'documents.noFolderLinkHint'),
          // Most customers had a folder before Parasoll: linking it comes first, so a second one is not made beside it.
          actions: canManage && createOffer !== undefined && (
            <>
              <LinkButton to={mappings} icon={<FolderLink20Regular />}>{t('documents.linkExisting')}</LinkButton>
              {createOffer && <Button icon={<FolderAdd20Regular />} onClick={onCreate}>{t('documents.createFolder')}</Button>}
            </>
          ),
        };
    }
  })();
  return (
    <div className={mergeClasses(styles.head, styles.stateHead)}>
      <IconChip icon={view.icon} tone={view.tone} />
      <div className={styles.stateBody}>
        <Text ref={heading} tabIndex={-1} className={styles.folderName}>{view.title}</Text>
        {view.hint && <Text className={settings.note}>{view.hint}</Text>}
        {view.actions && <div className={styles.actions}>{view.actions}</div>}
      </div>
    </div>
  );
}
