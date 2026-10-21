import { Children, useId, useRef, type ReactNode } from 'react';
import { Text, mergeClasses } from '@fluentui/react-components';
import { useTranslation } from 'react-i18next';
import { useScrollEdges } from '../../shared/utils/useScrollEdges';
import { useTechnicalStyles } from './technicalStyles';

/** Keep long technical records inside their panel without losing rows, native keyboard scrolling or focus. */
export function TechnicalList({ children, label, scrollHint }: { children: ReactNode; label: string; scrollHint?: string }) {
  const ref = useRef<HTMLUListElement>(null), hint = useId();
  const { t } = useTranslation(); const styles = useTechnicalStyles();
  const scroll = useScrollEdges(ref, 'y', children);
  return <>
    {scroll.overflow && <Text id={hint} block className={styles.status}>{scrollHint ?? t('parasolDetails.scrollList')}</Text>}
    <ul ref={ref} className={mergeClasses(styles.list, styles.scrollList)} style={scroll.style}
      aria-label={label} aria-describedby={scroll.overflow ? hint : undefined}
      tabIndex={Children.count(children) > 0 && scroll.overflow ? 0 : undefined}>
      {children}
    </ul>
  </>;
}
