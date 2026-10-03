import type { MouseEvent, ReactNode } from 'react';
import { Link } from '@fluentui/react-components';
import { useHref, useLinkClickHandler } from 'react-router';

interface AppLinkProps {
  to: string;
  children: ReactNode;
  className?: string;
  appearance?: 'default' | 'subtle';
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** Fluent-styled link with client-side navigation (keeps Ctrl/Cmd+click and middle-click behaviour). */
export function AppLink({ to, children, className, appearance, onClick }: AppLinkProps) {
  const href = useHref(to);
  const navigate = useLinkClickHandler<HTMLAnchorElement>(to);
  return (
    <Link
      as="a"
      href={href}
      className={className}
      appearance={appearance}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (!event.defaultPrevented) navigate(event);
      }}
    >
      {children}
    </Link>
  );
}
