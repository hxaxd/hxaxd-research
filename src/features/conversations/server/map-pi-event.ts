import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ChatMessage } from '../conversation-schema';
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((item: unknown) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string' ? item.text : '').join('\n');
}
export function mapPiMessage(id: string, value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null || !('role' in value) || !('content' in value)) return null;
  if (value.role === 'user' || value.role === 'assistant') {
    let text = textOf(value.content);
    const marker = '\n\n<research-workbench-materials>\n';
    const contextStart = text.lastIndexOf(marker);
    if (value.role === 'user' && contextStart >= 0 && text.endsWith('\n</research-workbench-materials>')) {
      try {
        const references = text.slice(contextStart + marker.length).split('\n').filter(line => line.startsWith('{')).map(line => (JSON.parse(line) as { path: string }).path.split('/').pop());
        if (references.length) text = `${text.slice(0, contextStart)}\n\n引用材料：${references.join('、')}`;
      } catch { /* User-written text resembling a context block stays visible as written. */ }
    }
    return { id, role: value.role, text };
  }
  if (value.role === 'toolResult') return { id, role: 'tool', text: textOf(value.content), toolName: 'toolName' in value && typeof value.toolName === 'string' ? value.toolName : '工具', isError: 'isError' in value && value.isError === true };
  return null;
}
export function mapPiEvent(event: AgentSessionEvent, messages: ChatMessage[], liveId: string): ChatMessage[] {
  if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
    const message = mapPiMessage(liveId, event.message);
    if (!message) return messages;
    const index = messages.findIndex(item => item.id === liveId);
    return index < 0 ? [...messages, message] : messages.map((item, i) => i === index ? message : item);
  }
  if (event.type === 'tool_execution_start') return [...messages.filter(message => message.id !== `tool:${event.toolCallId}`), { id: `tool:${event.toolCallId}`, role: 'tool', toolName: event.toolName, text: '正在执行…' }];
  if (event.type === 'tool_execution_end') return messages.map(message => message.id === `tool:${event.toolCallId}` ? { ...message, text: textOf(event.result.content), isError: event.isError } : message);
  return messages;
}
