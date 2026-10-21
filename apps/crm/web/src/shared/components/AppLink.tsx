import type { MouseEvent, ReactNode } from 'react';
import { Link } from '@fluentui/react-components';
import { useHref, useLinkClickHandler } from 'react-router';

interface AppLinkProps {
  to: string;
  children: ReactNode;
  className?: string;
  appearance?: 'default' | 'subtle';
  /** For a link that shows only an icon. */
  ariaLabel?: string;
  title?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** Fluent-styled link with client-side navigation (keeps Ctrl/Cmd+click and middle-click behaviour). */
export function AppLink({ to, children, className, appearance, ariaLabel, title, onClick }: AppLinkProps) {
  const href = useHref(to);
  const navigate = useLinkClickHandler<HTMLAnchorElement>(to);
  return (
    <Link
      as="a"
      href={href}
      className={className}
      appearance={appearance}
      aria-label={ariaLabel}
      title={title}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) navigate(event);
      }}
    >
      {children}
    </Link>
  );
}
