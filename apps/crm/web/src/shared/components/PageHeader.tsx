import type { ReactNode } from 'react';
import { Text, makeStyles, tokens } from '@fluentui/react-components';
import { AppLink } from './AppLink';
import { ArrowLeft16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    marginBottom: tokens.spacingVerticalL,
  },
  titles: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: 0 },
  back: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, fontSize: tokens.fontSizeBase200 },
  title: { margin: 0, fontSize: tokens.fontSizeHero700, lineHeight: tokens.lineHeightHero700, fontWeight: tokens.fontWeightSemibold, textWrap: 'balance' },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS },
});

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
}

export function PageHeader({ title, subtitle, meta, actions, back }: PageHeaderProps) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.titles}>
        {back && (
          <AppLink to={back.to} className={styles.back}>
            <ArrowLeft16Regular aria-hidden />
            {back.label}
          </AppLink>
        )}
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <Text style={{ color: tokens.colorNeutralForeground3 }}>{subtitle}</Text>}
        {meta && <div className={styles.meta}>{meta}</div>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
