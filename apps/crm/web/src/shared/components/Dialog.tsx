// The one place that wraps Fluent's Dialog; everything else imports this one (eslint no-restricted-imports).
// A dialog may open on a date or time field: the focusin Safari leaves out for those is sent app-wide (app/focusin.ts).
// eslint-disable-next-line no-restricted-imports
import { Dialog as FluentDialog, createPresenceComponent, useMergedRefs, type DialogProps } from '@fluentui/react-components';
import { cloneElement, useLayoutEffect, useRef, type ReactElement, type Ref, type RefObject } from 'react';
import { backOut, ease } from '../../app/motion';
import { lastUsedControls } from '../../app/usedControls';

// The reference's dialog entrance: it rises 12 px and grows from 98 % with a slight overshoot, and leaves faster.
// Fluent's presence motion skips the animation when the person asks for reduced motion.
// The surface's content mounts with it and stays until the exit has played: render it unconditionally, or from
// useKeptWhileClosing when it comes from state that closing clears, never as `{open && …}`.
const DialogRise = createPresenceComponent(() => {
  const hidden = { opacity: 0, transform: 'translateY(12px) scale(0.98)' };
  const shown = { opacity: 1, transform: 'none' };
  return {
    enter: { keyframes: [hidden, shown], duration: 450, easing: backOut(1.5) },
    exit: { keyframes: [shown, hidden], duration: 220, easing: ease.in },
  };
});

type SurfaceElement = ReactElement<{ ref?: Ref<HTMLElement> }>;

/**
 * Escape gives focus back to the control the dialog was opened from. Fluent does that on the blur of the focused field as
 * it is removed, and only Chromium sends one: in Firefox and Safari focus stayed on the page after Escape from a field.
 * Safari does not focus a clicked button either, so the control is the last one used before the dialog opened that is
 * still in the page (app/usedControls.ts). Focus that went anywhere else (the app's own choice, Chromium's return) stays.
 */
function ReturnFocusOnEscape({ children, escapedRef, ref }: { children: SurfaceElement; escapedRef: RefObject<boolean>; ref?: Ref<HTMLElement> }) {
  const surface = useRef<HTMLElement>(null);
  const surfaceRef = useMergedRefs(ref, surface, children.props.ref);
  useLayoutEffect(() => {
    const node = surface.current;
    const openers = lastUsedControls();
    escapedRef.current = false;
    // The cleanup runs while the surface is still in the page, so it can tell whether the surface held focus.
    return () => {
      const doc = node?.ownerDocument;
      if (!node || !doc || !escapedRef.current || !node.contains(doc.activeElement)) return;
      setTimeout(() => {
        if (doc.activeElement && doc.activeElement !== doc.body) return;
        for (const control of openers) {
          if (!control.isConnected || node.contains(control)) continue;
          control.focus();
          if (doc.activeElement === control) return;
        }
      });
    };
  }, [escapedRef]);
  return cloneElement(children, { ref: surfaceRef });
}

export function Dialog({ onOpenChange, ...props }: DialogProps) {
  // Whether Escape asked the dialog to close; read when its surface goes away.
  const escapedRef = useRef(false);
  return (
    <FluentDialog
      surfaceMotion={{
        children: (_, { children, ...motion }) => (
          <DialogRise {...motion}>
            <ReturnFocusOnEscape escapedRef={escapedRef}>{children as SurfaceElement}</ReturnFocusOnEscape>
          </DialogRise>
        ),
      }}
      {...props}
      onOpenChange={(event, data) => {
        escapedRef.current = data.type === 'escapeKeyDown';
        onOpenChange?.(event, data);
      }}
    />
  );
}
