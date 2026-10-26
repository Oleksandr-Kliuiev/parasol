// The one place that wraps Fluent's Dialog; everything else imports this one (eslint no-restricted-imports).
// eslint-disable-next-line no-restricted-imports
import { Dialog as FluentDialog, createPresenceComponent, type DialogProps } from '@fluentui/react-components';
import { backOut, ease } from '../../app/motion';

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

export function Dialog(props: DialogProps) {
  return <FluentDialog surfaceMotion={{ children: (_, motion) => <DialogRise {...motion} /> }} {...props} />;
}
