import { Link, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { DocumentPdf16Regular, History16Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { h } from '../../app/hearth';
import { AppLink } from '../../shared/components/AppLink';
import { DetailList, Panel } from '../../shared/components/Panel';
import { formatDate, formatDateTime } from '../../shared/utils/format';
import { quotePdfUrl } from './api';
import type { Quote } from './types';

const useStyles = makeStyles({
  section: { marginTop: '16px', paddingTop: '14px', borderTop: `1px solid ${h.line}` },
  heading: { display: 'block', marginBottom: '8px', color: h.muted, fontSize: '12px', fontWeight: 700, lineHeight: '16px' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' },
  // A stored document: the PDF chip, its revision line, the hash under it, the download on the right.
  document: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: '10px', alignItems: 'start' },
  chip: {
    display: 'grid',
    placeItems: 'center',
    width: '32px',
    height: '32px',
    borderRadius: '10px',
    backgroundColor: h.emberSoft,
    color: h.emberT,
    '& svg': { width: '16px', height: '16px' },
  },
  text: { display: 'grid', gap: '2px', minWidth: 0 },
  line: { fontSize: '13px', lineHeight: '18px', fontWeight: 600, overflowWrap: 'anywhere' },
  muted: { color: h.muted, fontSize: '12px', lineHeight: '16px' },
  mono: { fontFamily: tokens.fontFamilyMonospace },
  warning: { color: h.saffronT, fontSize: '12px', lineHeight: '16px' },
  download: { fontSize: '12.5px', justifySelf: 'start' },
  version: { fontSize: '13px' },
  current: { fontWeight: 700 },
});

/** When the version was made and sent, the documents stored for it (DEV-08) and the other versions of the quote. */
export function QuoteHistoryPanel({ quote, canSeeMoney }: { quote: Quote; canSeeMoney: boolean }) {
  const styles = useStyles();
  const { t } = useTranslation();

  return (
    <Panel title={t('quotes.sections.history')} icon={<History16Regular />}>
      <DetailList
        items={[
          { label: t('quotes.fields.issuedOn'), value: formatDate(quote.issuedOn) },
          { label: t('quotes.fields.approvedBy'), value: quote.approvedBy?.name },
          { label: t('quotes.fields.sentTo'), value: quote.sentTo },
          { label: t('quotes.fields.sentAt'), value: quote.sentAt ? formatDateTime(quote.sentAt) : null },
          { label: t('quotes.fields.declineReason'), value: quote.declineReason },
        ]}
      />
      {quote.documents.length > 0 && (
        <section aria-label={t('quotes.document.title')} className={styles.section}>
          <Text className={styles.heading}>{t('quotes.document.title')}</Text>
          <ul className={styles.list}>
            {quote.documents.map((document) => (
              <li key={document.revision} className={styles.document}>
                <span className={styles.chip} aria-hidden>
                  <DocumentPdf16Regular />
                </span>
                <span className={styles.text}>
                  <Text className={styles.line}>
                    {t('quotes.document.line', {
                      revision: document.revision,
                      origin: t(`quotes.document.origin.${document.origin}`),
                      status: t(`quotes.document.status.${document.status}`),
                      at: formatDateTime(document.readyAt ?? document.createdAt),
                    })}
                  </Text>
                  {document.sha256 && (
                    <Text className={mergeClasses(styles.muted, styles.mono)}>
                      SHA-256 {document.sha256.slice(0, 16)}…
                    </Text>
                  )}
                  {document.origin === 'Reconstructed' && <Text className={styles.warning}>{t('quotes.document.reconstructedNote')}</Text>}
                  {document.status === 'Ready' && canSeeMoney && (
                    <Link className={styles.download} href={quotePdfUrl(quote.id, document.revision)} target="_blank" rel="noopener noreferrer">
                      {t('quotes.document.download', { revision: document.revision })}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {quote.versions.length > 1 && (
        <section aria-label={t('quotes.versions')} className={styles.section}>
          <Text className={styles.heading}>{t('quotes.versions')}</Text>
          <ul className={styles.list}>
            {quote.versions.map((version) => (
              <li key={version.id} className={styles.version}>
                {version.id === quote.id ? (
                  <Text className={mergeClasses(styles.version, styles.current)}>
                    {t('quotes.versionLine', { version: version.versionNo, status: t(`quotes.status.${version.status}`) })}
                  </Text>
                ) : (
                  <AppLink to={`/quotes/${version.id}`}>
                    {t('quotes.versionLine', { version: version.versionNo, status: t(`quotes.status.${version.status}`) })}
                  </AppLink>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Panel>
  );
}
