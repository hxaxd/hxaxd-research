'use client';

import { useRef, useState } from 'react';

export function InlineName({
  name,
  label,
  onRename,
  className = '',
}: {
  name: string;
  label: string;
  onRename: (name: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
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
      setError('名称不能为空');
      return;
    }
    if (next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onRename(next);
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
          title={`${name} · 点击重命名`}
          onClick={() => {
            setDraft(name);
            setError('');
            setEditing(true);
          }}
        >
          {name}
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
