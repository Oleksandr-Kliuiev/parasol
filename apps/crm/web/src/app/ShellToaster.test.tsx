import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider } from '@fluentui/react-components';
import { useNotify } from '../shared/components/useNotify';
import { ShellToaster } from './ShellToaster';
import { lightTheme } from './theme';
import { toasterLoading } from './toaster';

function Save() {
  const notify = useNotify();
  return (
    <button type="button" onClick={() => notify('Organization created')}>
      Create
    </button>
  );
}

const shell = (toaster: boolean) => (
  <FluentProvider theme={lightTheme}>
    <Save />
    {toaster && <ShellToaster phone={false} />}
  </FluentProvider>
);

describe('ShellToaster', () => {
  it('shows a notice raised while the shell was still loading its toaster once the toaster listens', async () => {
    toasterLoading();
    const view = render(shell(false));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create' }));
    expect(document.querySelector('.fui-ToastTitle')).toBeNull();

    view.rerender(shell(true));
    await screen.findByText('Organization created', { selector: '.fui-ToastTitle' });
  });

  it('shows a notice at once when the toaster already listens', async () => {
    render(shell(true));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Organization created', { selector: '.fui-ToastTitle' });
  });
});
