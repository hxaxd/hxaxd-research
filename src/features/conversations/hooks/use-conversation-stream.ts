'use client';
import { useEffect, useState } from 'react';
import { conversationEventSchema, type ConversationSnapshot } from '../conversation-schema';
import { requestJson } from '@/shared/http/request-json';
export function useConversationStream(url: string) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null), [connected, setConnected] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const stream = new EventSource(`${url}/events`);
    const controller = new AbortController();
    stream.onopen = () => { setConnected(true); setError(''); };
    stream.onmessage = event => {
      try { setSnapshot(conversationEventSchema.parse(JSON.parse(event.data)).snapshot); }
      catch { setError('对话数据无法读取，请刷新页面'); }
    };
    stream.onerror = () => { setConnected(false); void requestJson<ConversationSnapshot>(url, { signal: controller.signal }).then(setSnapshot).catch(error => { if (!controller.signal.aborted) setError(error.message); }); };
    return () => { controller.abort(); stream.close(); };
  }, [url]);
  return { snapshot, connected, error };
}
