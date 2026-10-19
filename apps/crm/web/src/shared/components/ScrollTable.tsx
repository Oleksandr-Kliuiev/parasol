import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useScrollEdges } from '../utils/useScrollEdges';

const useStyles = makeStyles({
  wrap: {
    overflowX: 'auto',
    scrollPaddingInline: '16px',
    backgroundColor: tokens.colorNeutralBackground1,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow4,
    ':focus-visible': { outline: `2px solid ${tokens.colorStrokeFocus2}`, outlineOffset: '2px' },
  },
});

function scrollOnKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!direction) return;
  event.preventDefault();
  event.currentTarget.scrollBy({ left: direction * event.currentTarget.clientWidth * 0.75, behavior: 'instant' });
}

/**
 * A card that holds a wide table (UX concept §8, "table with a fading edge"). Only when the table is wider than the
 * card does the card become a focusable, labelled region: the edges that hide more columns fade, and the arrow keys
 * scroll it for someone without a mouse. A table that fits stays an ordinary block.
 */
export function ScrollTable({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const styles = useStyles();
  const { t, i18n } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref, 'x', i18n.resolvedLanguage);
  return (
    <div
      ref={ref}
      className={mergeClasses(styles.wrap, className)}
      style={edges.style}
      role={edges.overflow ? 'region' : undefined}
      aria-label={edges.overflow ? (label ?? t('common.scrollableTable')) : undefined}
      tabIndex={edges.overflow ? 0 : undefined}
      onKeyDown={scrollOnKeyDown}
    >
      {children}
    </div>
  );
}
