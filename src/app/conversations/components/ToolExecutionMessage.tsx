'use client';

import '../conversations.css';
import './ToolExecutionMessage.css';


import { useTranslations } from 'use-intl';

import { CheckCircle2, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react';

import type { ChatMessage } from '../schema';

export function ToolExecutionMessage({ message }: { message: ChatMessage }) {
  const t = useTranslations();
  const labels: Record<string, string> = {
    get_workspace_context: t('tools.workspace'),
    read: t('tools.read'),
    write: t('tools.write'),
    edit: t('tools.edit'),
    bash: t('tools.command'),
    powershell: t('tools.command'),
    read_pdf_pages: t('tools.pdf'),
    open_document: t('tools.openDocument'),
  };
  return (
    <details className={`tool-message ${message.isError ? 'tool-error' : ''}`}>
      <summary>
        {message.isError ? (
          <TriangleAlert size={15} aria-hidden="true" />
        ) : message.pending ? (
          <LoaderCircle className="tool-spinner" size={15} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={15} aria-hidden="true" />
        )}
        <span>{labels[message.toolName ?? ''] || message.toolName}</span>
        <span className="tool-state">
          {message.isError ? t('common.failed') : message.pending ? t('tools.pending') : t('tools.result')}
        </span>
        <ChevronDown className="tool-chevron" size={13} aria-hidden="true" />
      </summary>
      <pre>{message.pending ? t('tools.pending') : message.text}</pre>
    </details>
  );
}
