'use client';

import './EntityControls.css';


import { useTranslations } from 'use-intl';

import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { clsx } from 'clsx';
import { Check, Plus, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

export function CreateEntityDialog({
  title,
  initialName = '',
  onSubmit,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  initialName?: string;
  onSubmit: (name: string) => Promise<void>;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError('');
          setName(initialName);
        }
      }}
    >
      {children && <Dialog.Trigger asChild>{children}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t('common.close')}>
              <X size={18} />
            </Dialog.Close>
          </div>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (busy || !name.trim()) return;
              setBusy(true);
              setError('');
              try {
                await onSubmit(name.trim());
                setOpen(false);
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field-label" htmlFor="entity-name">
              {t('common.name')}
            </label>
            <input
              id="entity-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              placeholder={t('common.name')}
              disabled={busy}
            />
            {error && (
              <p role="alert" className="error-message">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              <Dialog.Close className="button secondary" disabled={busy}>
                {t('common.cancel')}
              </Dialog.Close>
              <button
                className="button primary"
                disabled={busy || !name.trim()}
              >
                {busy ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EntitySwitcher({
  value,
  label,
  nameLabel,
  items,
  onSelect,
  onCreate,
  createLabel,
  onSave,
  leading,
  className = '',
}: {
  value: string;
  label: string;
  nameLabel: string;
  items: { id: string; name: string }[];
  onSelect: (id: string) => void;
  onCreate: () => void;
  createLabel: string;
  onSave: (value: string) => Promise<void>;
  leading?: ReactNode;
  className?: string;
}) {
  const t = useTranslations();
  const selected = items.find(item => item.id === value);
  const name = selected?.name ?? label;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelled = useRef(false);
  const anchor = useRef<HTMLSpanElement>(null);

  async function save() {
    if (cancelled.current) {
      cancelled.current = false;
      setEditing(false);
      return;
    }
    const next = draft.trim();
    if (!next) {
      setError(t('errors.nameRequired'));
      return;
    }
    if (next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      setEditing(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
      <span ref={anchor} className={clsx('entity-switcher', className)} data-open={open}>
        {editing ? (
          <>
          {leading}
          <input
            aria-label={nameLabel}
            value={draft}
            maxLength={160}
            disabled={busy}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void save()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' || event.key === 'Enter') {
                event.preventDefault();
                cancelled.current = event.key === 'Escape';
                event.currentTarget.blur();
              }
            }}
          />
          </>
        ) : (
          <Popover.Trigger asChild>
          <button
            className="entity-switcher-name"
            aria-label={open && selected ? t('common.renameItem', { value0: name }) : label}
            aria-expanded={open}
            aria-haspopup="dialog"
            title={name}
            onClick={event => {
              event.preventDefault();
              if (!open || !selected) { setOpen(true); return; }
              setOpen(false);
              setDraft(name);
              setError('');
              setEditing(true);
            }}
          >
            {leading}
            <span>{name}</span>
          </button>
          </Popover.Trigger>
        )}
        {error && (
          <span className="inline-name-error" role="alert">
            {error}
          </span>
        )}
      </span>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content className="entity-switcher-menu menu-surface" aria-label={label} align="start" sideOffset={8} collisionPadding={12}
          onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
          onCloseAutoFocus={event => { if (editing) event.preventDefault(); }}>
          <div className="entity-switcher-list" role="group" aria-label={label}>
            {items.map(item => <button className="menu-item" key={item.id} aria-pressed={item.id === value}
              title={item.name} onClick={() => { onSelect(item.id); setOpen(false); }}>
              <span>{item.name}</span>{item.id === value && <Check size={15} aria-hidden="true" />}
            </button>)}
          </div>
          <button className="menu-item entity-switcher-create" onClick={() => { setOpen(false); onCreate(); }}>
            <Plus size={16} aria-hidden="true" />{createLabel}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
