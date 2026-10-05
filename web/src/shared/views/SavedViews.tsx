import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Field, Input,
  Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, MessageBar, MessageBarBody,
} from '@fluentui/react-components';
import { Bookmark20Regular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';
import { useCurrentUser } from '../../auth/CurrentUserContext';
import { cleanQuery, MAX_NAME, readViews, upsertView, viewsKey, writeViews, type SavedView } from './store';

interface SavedViewsProps {
  /** Names the list, e.g. `organizations`. */
  scope: string;
  /** The address parameters that make up a view: filters and sort, never paging cursors or amounts. */
  keys: readonly string[];
}

/** Saved filter combinations for a list whose filters live in the address. */
export function SavedViews({ scope, keys }: SavedViewsProps) {
  const user = useCurrentUser();
  // A different account in the same browser starts from its own views.
  return <SavedViewsFor key={user.id} userId={user.id} scope={scope} keys={keys} />;
}

function SavedViewsFor({ userId, scope, keys }: SavedViewsProps & { userId: string }) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const storageKey = viewsKey(userId, scope);
  const [state, setState] = useState(() => readViews(window.localStorage, storageKey, keys));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<'full' | 'storage' | null>(null);
  const [notice, setNotice] = useState(state.discarded);

  const current = cleanQuery(params.toString(), keys);

  const commit = (views: SavedView[]) => {
    if (!writeViews(window.localStorage, storageKey, views)) {
      setProblem('storage');
      return false;
    }
    setState({ views, discarded: false });
    setNotice(false);
    setProblem(null);
    return true;
  };

  const apply = (view: SavedView) => {
    const next = new URLSearchParams(params);
    for (const key of keys) next.delete(key);
    for (const [key, value] of new URLSearchParams(view.query)) next.set(key, value);
    // A different filter starts at the first page.
    next.delete('cursor');
    setParams(next);
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = upsertView(state.views, { name: trimmed, query: current });
    if (next === 'full') {
      setProblem('full');
      return;
    }
    if (commit(next)) {
      setNaming(false);
      setName('');
    }
  };

  return (
    <>
      <Menu>
        <MenuTrigger disableButtonEnhancement>
          <Button icon={<Bookmark20Regular />}>{t('views.button')}</Button>
        </MenuTrigger>
        <MenuPopover>
          <MenuList>
            {state.views.length === 0 && <MenuItem disabled>{t('views.none')}</MenuItem>}
            {state.views.map((view) => (
              <MenuItem key={view.name} onClick={() => apply(view)}>
                {view.name}
              </MenuItem>
            ))}
            <MenuDivider />
            <MenuItem onClick={() => setNaming(true)}>{t('views.saveCurrent')}</MenuItem>
            {state.views.length > 0 && (
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem>{t('views.delete')}</MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    {state.views.map((view) => (
                      <MenuItem key={view.name} onClick={() => commit(state.views.filter((v) => v.name !== view.name))}>
                        {view.name}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
            )}
          </MenuList>
        </MenuPopover>
      </Menu>

      <Dialog open={naming} onOpenChange={(_, d) => { setNaming(d.open); if (!d.open) setProblem(null); }}>
        <DialogSurface>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <DialogBody>
              <DialogTitle>{t('views.saveCurrent')}</DialogTitle>
              <DialogContent>
                <Field label={t('views.name')} hint={t('views.hint')} required>
                  <Input value={name} maxLength={MAX_NAME} onChange={(_, d) => setName(d.value)} />
                </Field>
                {problem && (
                  <MessageBar intent="error" role="alert" style={{ marginTop: 8 }}>
                    <MessageBarBody>{problem === 'full' ? t('views.full') : t('views.storageFailed')}</MessageBarBody>
                  </MessageBar>
                )}
              </DialogContent>
              <DialogActions>
                <DialogTrigger disableButtonEnhancement>
                  <Button>{t('common.cancel')}</Button>
                </DialogTrigger>
                <Button appearance="primary" type="submit" disabled={!name.trim()}>
                  {t('common.save')}
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>

      {notice && (
        <MessageBar intent="info" role="status">
          <MessageBarBody>{t('views.discarded')}</MessageBarBody>
        </MessageBar>
      )}
    </>
  );
}
