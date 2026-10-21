import { useState } from 'react';
import { Badge, Button, Field, Radio, RadioGroup, Spinner, Text, Textarea, makeStyles, mergeClasses } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { h } from '../../../app/hearth';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ErrorState } from '../../../shared/components/ErrorState';
import { formatDateTime, formatRelative } from '../../../shared/utils/format';
import type { TicketComment, TicketDetail } from '../types';
import { useTicketComments } from './api';
import { ticketRequest, type TicketActionAsk } from './ticketActions';

const MAX_TEXT = 8000;

const useStyles = makeStyles({
  section: { display: 'grid', gap: '12px', minWidth: 0 },
  heading: { margin: 0, fontSize: '15px', lineHeight: '22px', fontWeight: 700 },
  list: { listStyleType: 'none', margin: 0, padding: 0, display: 'grid', gap: '10px' },
  // A message as a quiet card: the customer's on the surface, a technician's reply tinted, an internal note in the warning tint.
  message: { display: 'grid', gap: '4px', padding: '10px 12px', borderRadius: '12px', border: `1px solid ${h.line}`, minWidth: 0 },
  reply: { backgroundColor: h.surface2 },
  note: { backgroundColor: h.saffronSoft, borderTopColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: 'transparent' },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', fontSize: '12.5px', lineHeight: '18px', color: h.muted },
  author: { fontWeight: 600, color: h.text },
  text: { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px', lineHeight: '20px' },
  earlier: { justifySelf: 'center' },
  composer: { display: 'grid', gap: '8px' },
  send: { justifySelf: 'start' },
  muted: { color: h.muted, fontSize: '12.5px', lineHeight: '18px' },
  quote: { margin: 0, paddingLeft: '12px', borderLeft: `3px solid ${h.line2}`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '30vh', overflowY: 'auto' },
});

/**
 * A ticket's conversation as the CRM last read it (M39.2), oldest first with the earlier messages a click away, and the way to answer:
 * a reply the customer sees or a note only technicians see, sent through the one action confirmation.
 */
export function TicketConversation({ ticket, canWrite, onAsk }: { ticket: TicketDetail; canWrite: boolean; onAsk: (ask: TicketActionAsk) => void }) {
  const { t } = useTranslation(); const styles = useStyles();
  const comments = useTicketComments(ticket.id);
  // The newest page comes first from the server; the conversation reads from the oldest loaded message down.
  const shown = [...comments.items].reverse();
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');
  const number = `#${ticket.externalId}`;
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onAsk({
      request: ticketRequest(ticket, mode === 'reply' ? 'ticket.reply' : 'ticket.note', { text: trimmed }),
      title: t(mode === 'reply' ? 'tickets.composer.replyTitle' : 'tickets.composer.noteTitle', { number }),
      confirm: t(mode === 'reply' ? 'tickets.composer.sendReply' : 'tickets.composer.addNote'),
      details: <blockquote className={styles.quote}>{trimmed}</blockquote>,
      // Emptied once the command is saved, so a closed dialog never leaves a sent text to be sent again.
      onAccepted: () => setText(''),
      onFinished: (action) => { if (action.status === 'Succeeded') void comments.refetch(); },
    });
  };

  return <section className={styles.section} aria-labelledby={`ticket-conversation-${ticket.id}`}>
    <h3 id={`ticket-conversation-${ticket.id}`} className={styles.heading}>{t('tickets.conversation.title')}</h3>
    <Text className={styles.muted}>{ticket.commentsReadAt
      ? <>{t('tickets.conversation.readAt')} <time dateTime={ticket.commentsReadAt} title={formatDateTime(ticket.commentsReadAt)}>{formatRelative(ticket.commentsReadAt)}</time></>
      : t('tickets.conversation.notRead')}</Text>
    {comments.isPending && <Spinner size="small" label={t('common.loading')} />}
    {comments.isError && <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />}
    {comments.hasNextPage && <Button className={styles.earlier} size="small" disabled={comments.isFetchingNextPage} onClick={() => void comments.fetchNextPage()}>
      {t('tickets.conversation.earlier', { shown: shown.length, total: comments.total ?? shown.length })}</Button>}
    {comments.isSuccess && shown.length === 0 && <EmptyState compact message={t(ticket.commentsReadAt ? 'tickets.conversation.empty' : 'tickets.conversation.emptyUnread')} />}
    {shown.length > 0 && <ol className={styles.list}>{shown.map((comment) => <Message key={comment.id} comment={comment} />)}</ol>}
    {canWrite && <div className={styles.composer}>
      <RadioGroup layout="horizontal" value={mode} onChange={(_, data) => setMode(data.value as 'reply' | 'note')} aria-label={t('tickets.composer.kind')}>
        <Radio value="reply" label={t('tickets.composer.reply')} />
        <Radio value="note" label={t('tickets.composer.note')} />
      </RadioGroup>
      <Field label={t(mode === 'reply' ? 'tickets.composer.replyLabel' : 'tickets.composer.noteLabel')}
        hint={t(mode === 'reply' ? 'tickets.composer.replyHint' : 'tickets.composer.noteHint')}>
        <Textarea value={text} onChange={(_, data) => setText(data.value)} maxLength={MAX_TEXT} resize="vertical" rows={4} />
      </Field>
      <Button className={styles.send} appearance="primary" disabled={!text.trim()} onClick={send}>
        {t(mode === 'reply' ? 'tickets.composer.sendReply' : 'tickets.composer.addNote')}</Button>
    </div>}
  </section>;
}

function Message({ comment }: { comment: TicketComment }) {
  const { t } = useTranslation(); const styles = useStyles();
  const author = comment.authorName ?? t(`tickets.conversation.authors.${comment.author}`);
  return <li className={mergeClasses(styles.message, comment.isInternal ? styles.note : comment.author === 'Technician' && styles.reply)}>
    <div className={styles.head}>
      <span className={styles.author}>{author}</span>
      {comment.isInternal
        ? <Badge appearance="tint" color="warning">{t('tickets.conversation.internal')}</Badge>
        : <span>{t(`tickets.conversation.roles.${comment.author}`)}</span>}
      <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)}>{formatRelative(comment.createdAt)}</time>
    </div>
    <p className={styles.text}>{comment.text}</p>
  </li>;
}
