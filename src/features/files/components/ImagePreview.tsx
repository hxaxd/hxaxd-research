'use client';

import { Check, Quote, Scan, X } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';

import type { ImageClip } from '../schema';

type Point = { x: number; y: number };

export function ImagePreview({ url, path, onCapture }: {
  url: string; path: string; onCapture: (clip: ImageClip) => Promise<void>;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [from, setFrom] = useState<Point | null>(null);
  const [to, setTo] = useState<Point | null>(null);
  const dragging = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const box = from && to ? {
    x: Math.min(from.x, to.x), y: Math.min(from.y, to.y),
    width: Math.abs(from.x - to.x), height: Math.abs(from.y - to.y),
  } : null;
  function point(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  }
  async function capture(region = { x: 0, y: 0, width: 1, height: 1 }) {
    setBusy(true);
    setError('');
    try {
      const source = image.current!;
      if (!source.naturalWidth) throw new Error('图片尚未加载完成');
      const width = region.width * source.naturalWidth;
      const height = region.height * source.naturalHeight;
      const scale = Math.min(1, 2048 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d')!.drawImage(source, region.x * source.naturalWidth, region.y * source.naturalHeight,
        width, height, 0, 0, canvas.width, canvas.height);
      await onCapture({ path, data: canvas.toDataURL('image/png').split(',')[1] });
      setSelecting(false);
      setFrom(null);
      setTo(null);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="image-reader">
    <div className="image-reference-toolbar">
      {error && <span role="alert">{error}</span>}
      <button className="button secondary" disabled={busy} onClick={() => { setSelecting(!selecting); setFrom(null); setTo(null); }}>
        <Scan size={16} aria-hidden="true" />{selecting ? '取消框选' : '框选引用'}</button>
      <button className="button secondary" disabled={busy} onClick={() => void capture()}><Quote size={16} aria-hidden="true" />引用图片</button>
    </div>
    <div className="image-preview"><div className="image-selection-surface">
      <img ref={image} src={url} alt={path.split('/').pop()} draggable={false} />
      {selecting && <div className="image-selection-overlay" aria-label="图片框选区域"
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || busy) return;
          const next = point(event);
          if (!from || (box && box.width > 0.01 && box.height > 0.01)) setFrom(next);
          setTo(next);
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => { if (dragging.current) setTo(point(event)); }}
        onPointerUp={event => { dragging.current = false; setTo(point(event)); }}
        onPointerCancel={() => { dragging.current = false; setFrom(null); setTo(null); }}>
        {box && <div className="pdf-selection-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }} />}
      </div>}
    </div></div>
    {selecting && <div className="image-reference-toolbar" role="group" aria-label="图片引用操作">
      <span>拖动框选，或点按两个对角</span>
      <button className="button secondary" disabled={busy} onClick={() => setSelecting(false)}><X size={16} />取消</button>
      <button className="button" disabled={busy || !box || box.width < 0.01 || box.height < 0.01} onClick={() => void capture(box!)}><Check size={16} />加入提问</button>
    </div>}
  </div>;
}
