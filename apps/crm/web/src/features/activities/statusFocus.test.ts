import { afterEach, expect, it, vi } from 'vitest';
import { captureStatusFocus } from './statusFocus';

const mounted: HTMLElement[] = [];
function button(parent = document.body) {
  const control = document.createElement('button'); parent.append(control); mounted.push(control); return control;
}
function surface(role = 'dialog') {
  const element = document.createElement('div'); element.setAttribute('role', role); document.body.append(element); mounted.push(element); return element;
}
afterEach(() => { for (const element of mounted.splice(0)) element.remove(); });

it('restores status focus while a closed, empty dialog surface remains mounted for exit motion', () => {
  const closing = surface(); const trigger = button(); trigger.focus(); const disposed = vi.fn();
  const owner = captureStatusFocus(trigger, disposed, () => false);
  expect(owner).not.toBeNull(); trigger.remove(); const replacement = button(); owner!.restore(replacement);
  expect(closing.isConnected).toBe(true); expect(replacement).toHaveFocus(); expect(disposed).toHaveBeenCalledOnce();
  owner!.restore(trigger); expect(replacement).toHaveFocus(); expect(disposed).toHaveBeenCalledOnce();
});

it('does not capture ownership when the editor is opening before its portal mounts', () => {
  const trigger = button(); trigger.focus(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(captureStatusFocus(trigger, vi.fn(), () => true)).toBeNull();
});

it('consults the current editor lifecycle before restoring a command that began before it opened', () => {
  let open = false; const trigger = button(); trigger.focus(); const disposed = vi.fn();
  const owner = captureStatusFocus(trigger, disposed, () => open)!; trigger.remove(); open = true;
  const replacement = button(); owner.restore(replacement); expect(replacement).not.toHaveFocus(); expect(disposed).toHaveBeenCalledOnce();
});

it.each(['aria-hidden', 'inert'])('does not capture or restore a status control inside an active modal’s %s background', attribute => {
  const background = document.createElement('main'); document.body.append(background); mounted.push(background);
  const trigger = button(background); trigger.focus(); background.setAttribute(attribute, 'true');
  expect(captureStatusFocus(trigger, vi.fn(), () => false)).toBeNull(); background.removeAttribute(attribute);
  const disposed = vi.fn(); const owner = captureStatusFocus(trigger, disposed, () => false)!;
  trigger.remove(); background.setAttribute(attribute, 'true'); const replacement = button(background); owner.restore(replacement);
  expect(replacement).not.toHaveFocus(); expect(disposed).toHaveBeenCalledOnce();
});

it.each(['dialog', 'alertdialog'])('does not take focus from another active %s', role => {
  const trigger = button(); trigger.focus(); const disposed = vi.fn(); const owner = captureStatusFocus(trigger, disposed, () => false)!;
  const modal = surface(role); const field = document.createElement('input'); modal.append(field); field.focus(); trigger.remove();
  owner.restore(button()); expect(field).toHaveFocus(); expect(disposed).toHaveBeenCalledOnce();
});
