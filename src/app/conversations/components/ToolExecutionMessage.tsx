'use client';

import '../conversations.css';
import './ToolExecutionMessage.css';

import { clsx } from 'clsx';
import { CheckCircle2, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';

import type { ChatMessage } from '../schema';

const summaryClass = 'flex min-h-[30px] cursor-pointer list-none items-center gap-[7px] p-1 text-muted-foreground [&::-webkit-details-marker]:hidden';

export function ToolExecutionGroup({ messages }: { messages: ChatMessage[] }) {
  const t = useTranslations();
  if (messages.length === 1) return <ToolExecutionMessage message={messages[0]} />;
  const pending = messages.some(message => message.pending);
  const failures = messages.filter(message => message.isError).length;
  return <details className={clsx('tool-message group/tools', failures && 'tool-error')} open={failures > 0 || undefined}>
    <summary className={summaryClass}>
      <StatusIcon pending={pending} error={failures > 0} />
      <span className="truncate">{t('tools.group', { count: messages.length })}</span>
      <span className="tool-state">{[failures ? t('tools.failures', { count: failures }) : '', pending ? t('tools.pending') : ''].filter(Boolean).join(' · ')}</span>
      <ChevronDown className="tool-chevron" size={13} aria-hidden="true" />
    </summary>
    <div className="ml-2.5 mt-1 border-l border-control-line pl-3">
      {messages.map(message => <ToolExecutionMessage key={message.id} message={message} />)}
    </div>
  </details>;
}

function StatusIcon({ pending, error }: { pending?: boolean; error?: boolean }) {
  if (error) return <TriangleAlert className="flex-none text-danger" size={15} aria-hidden="true" />;
  if (pending) return <LoaderCircle className="tool-spinner flex-none text-accent" size={15} aria-hidden="true" />;
  return <CheckCircle2 className="flex-none text-accent" size={15} aria-hidden="true" />;
}

function text(value: unknown) {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** One line describing what the call acted on, such as a path, page range, query or command. */
function useArgumentSummary(message: ChatMessage) {
  const t = useTranslations();
  const args = message.args ?? {};
  const path = text(args.path) || text(args.file_path);
  switch (message.toolName) {
    case 'read_pdf_pages': {
      const start = text(args.startPage);
      const end = text(args.endPage);
      const pages = start && end && start !== end ? t('tools.pages', { start, end }) : start ? t('tools.page', { value0: start }) : '';
      return [path, pages].filter(Boolean).join(' · ');
    }
    case 'open_document':
      return [path, text(args.page) && t('tools.page', { value0: text(args.page) })].filter(Boolean).join(' · ');
    case 'web_search': return text(args.query);
    case 'ask_user': return text(args.prompt);
    case 'bash':
    case 'powershell': return text(args.command);
    default: return path;
  }
}

function ToolExecutionMessage({ message }: { message: ChatMessage }) {
  const t = useTranslations();
  const labels: Record<string, string> = {
    ask_user: t('tools.askUser'),
    web_search: t('tools.webSearch'),
    get_workspace_context: t('tools.workspace'),
    read: t('tools.read'),
    write: t('tools.write'),
    edit: t('tools.edit'),
    bash: t('tools.command'),
    powershell: t('tools.command'),
    read_pdf_pages: t('tools.pdf'),
    open_document: t('tools.openDocument'),
  };
  const summary = useArgumentSummary(message);
  const hasArgs = !!message.args && Object.keys(message.args).length > 0;
  return (
    <details className={clsx('tool-message', message.isError && 'tool-error')} open={message.isError || undefined}>
      <summary className={summaryClass} title={summary || undefined}>
        <StatusIcon pending={message.pending} error={message.isError} />
        <span className={clsx('flex-none', message.isError && 'text-danger')}>{labels[message.toolName ?? ''] || message.toolName}</span>
        {summary && <span className="min-w-0 truncate font-mono text-[0.785714rem] opacity-80">{summary}</span>}
        <span className="tool-state">
          {message.isError ? t('common.failed') : message.pending ? t('tools.pending') : ''}
        </span>
        <ChevronDown className="tool-chevron" size={13} aria-hidden="true" />
      </summary>
      <div className="mb-1 grid gap-2 pl-[26px]">
        {hasArgs && <ToolSection label={t('tools.input')}>{JSON.stringify(message.args, null, 2)}</ToolSection>}
        <ToolSection label={t('tools.output')} error={message.isError}>
          {message.pending ? t('tools.pending') : message.text || t('tools.noOutput')}
        </ToolSection>
      </div>
    </details>
  );
}

function ToolSection({ label, error, children }: { label: string; error?: boolean; children: string }) {
  return <section className="grid gap-1">
    <h4 className="text-[0.714286rem] font-semibold uppercase tracking-wide text-muted-foreground">{label}</h4>
    <pre className={clsx(
      'm-0 max-h-[230px] overflow-auto whitespace-pre-wrap rounded-lg border p-2.5 font-mono text-[0.785714rem] [overflow-wrap:anywhere]',
      error ? 'border-danger-line bg-danger-soft text-danger' : 'border-control-line bg-inset',
    )}>{children}</pre>
  </section>;
}
