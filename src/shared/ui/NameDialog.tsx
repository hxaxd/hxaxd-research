'use client';
import * as Dialog from '@radix-ui/react-dialog';
import { useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function NameDialog({ title, label, initialName = '', onSubmit, children }: { title: string; label: string; initialName?: string; onSubmit: (name: string, id: string) => Promise<void>; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef<{ id: string; name: string } | null>(null);
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(''); setName(initialName); } }}>
    <Dialog.Trigger asChild>{children}</Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content">
      <div className="dialog-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭"><X size={18} /></Dialog.Close></div>
      <Dialog.Description className="muted">{label}</Dialog.Description>
      <form onSubmit={async event => {
        event.preventDefault(); if (busy || !name.trim()) return;
        if (!submission.current || submission.current.name !== name.trim()) submission.current = { id: crypto.randomUUID(), name: name.trim() };
        setBusy(true); setError('');
        try { await onSubmit(name.trim(), submission.current.id); submission.current = null; setOpen(false); }
        catch (error) { setError(error instanceof Error ? error.message : '保存失败'); }
        finally { setBusy(false); }
      }}>
        <label className="field-label" htmlFor="entity-name">名称</label>
        <input id="entity-name" autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={160} placeholder="输入名称" disabled={busy} />
        {error && <p role="alert" className="error-message">{error}</p>}
        <div className="dialog-actions"><Dialog.Close className="button secondary" disabled={busy}>取消</Dialog.Close><button className="button primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</button></div>
      </form>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
