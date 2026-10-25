'use client';

import { useTranslations } from 'use-intl';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

export function CreateEntityDialog({
  title,
  label,
  initialName = '',
  onSubmit,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  title: string;
  label: string;
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
        <Dialog.Content className="dialog-content">
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={t('common.close')}>
              <X size={18} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">{label}</Dialog.Description>
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

export function EditableText({
  value,
  label,
  onSave,
  className = '',
}: {
  value: string;
  label: string;
  onSave: (value: string) => Promise<void>;
  className?: string;
}) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelled = useRef(false);

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
    if (next === value) {
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
    <span className={`inline-name ${className}`}>
      {editing ? (
        <input
          aria-label={label}
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
      ) : (
        <button
          title={t('common.renameItem', {value0: value})}
          onClick={() => {
            setDraft(value);
            setError('');
            setEditing(true);
          }}
        >
          {value}
        </button>
      )}
      {error && (
        <span className="inline-name-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
