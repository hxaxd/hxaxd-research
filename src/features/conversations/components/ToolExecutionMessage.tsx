import { CheckCircle2, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react';

import type { ChatMessage } from '../schema';

const labels: Record<string, string> = {
  get_workspace_context: '查看工作区',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  bash: '执行命令',
  powershell: '执行命令',
  read_pdf_pages: '读取 PDF',
};

export function ToolExecutionMessage({ message }: { message: ChatMessage }) {
  return (
    <details className={`tool-message ${message.isError ? 'tool-error' : ''}`}>
      <summary>
        {message.isError ? (
          <TriangleAlert size={15} aria-hidden="true" />
        ) : message.text === '正在执行…' ? (
          <LoaderCircle className="tool-spinner" size={15} aria-hidden="true" />
        ) : (
          <CheckCircle2 size={15} aria-hidden="true" />
        )}
        <span>{labels[message.toolName ?? ''] || message.toolName}</span>
        <span className="tool-state">
          {message.isError ? '失败' : message.text === '正在执行…' ? '执行中' : '查看结果'}
        </span>
        <ChevronDown className="tool-chevron" size={13} aria-hidden="true" />
      </summary>
      <pre>{message.text}</pre>
    </details>
  );
}
