import type { ChatMessage } from '../conversation-schema';
import { Wrench } from 'lucide-react';
const labels: Record<string, string> = { list_workspace_files: '浏览材料', read_workspace_text: '读取文本', read_pdf_pages: '读取 PDF', write_workspace_text: '写入文本', edit_workspace_text: '修改文本' };
export function ToolExecutionMessage({ message }: { message: ChatMessage }) {
  return <details className={`tool-message ${message.isError ? 'tool-error' : ''}`}><summary><Wrench size={13} /><span>{labels[message.toolName ?? ''] || message.toolName}</span><span className="tool-state">{message.isError ? '失败' : message.text === '正在执行…' ? '执行中' : '查看结果'}</span></summary><pre>{message.text}</pre></details>;
}
