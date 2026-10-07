'use client';
import { useEffect, useState } from 'react';
import { requestJson } from '@/shared/http/request-json';
import { textFileSchema } from '../file-schema';
import type { z } from 'zod';
export function TextFilePreview({ url }: { url: string }) {
  const [file, setFile] = useState<z.infer<typeof textFileSchema> | null>(null), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); void requestJson<z.infer<typeof textFileSchema>>(`${url}&format=text`, { signal: controller.signal }).then(setFile).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [url]);
  if (error) return <p role="alert" className="error-message">{error}</p>;
  if (!file) return <p className="empty-small">读取文本…</p>;
  return <div className="text-preview">{file.truncated && <p className="preview-notice">显示前 100,000 字节，完整内容可下载。</p>}<pre>{file.text}</pre></div>;
}
