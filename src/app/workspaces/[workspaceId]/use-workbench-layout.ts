'use client';

import { useTranslations } from 'use-intl';
import { z } from 'zod';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

type Side = 'materials' | 'conversation';
type Panel = { open: boolean; width: number };
type Drag = { side: Side; width: number; closing: boolean; left: number; right: number; scale: number; maximum: number };
const minimum = { materials: 240, conversation: 300 };
const key = 'research-layout';
const duration = 180;
const savedPanel = z.object({ open: z.boolean(), width: z.number().positive() }).optional().catch(undefined);
const savedLayout = z.object({ materials: savedPanel, conversation: savedPanel });

function parseLayout(saved: string | null): z.infer<typeof savedLayout> {
  if (!saved) return {};
  let value: unknown;
  try {
    value = JSON.parse(saved);
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  const result = savedLayout.safeParse(value);
  return result.success ? result.data : {};
}

function subscribe(listener: () => void) {
  window.addEventListener('research-layout', listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener('research-layout', listener);
    window.removeEventListener('storage', listener);
  };
}

function columns(materials: number, conversation: number, materialsHeader: number) {
  return {
    main: { gridTemplateColumns: `${materials}px 0 minmax(0, 1fr) 0 ${conversation}px` },
    header: { gridTemplateColumns: `${materialsHeader}px minmax(0, 1fr) ${Math.max(146, conversation)}px` },
  };
}

export function useWorkbenchLayout(ref: RefObject<HTMLElement | null>) {
  const t = useTranslations();
  const saved = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key),
    () => null,
  );
  const [available, setAvailable] = useState(1400);
  const tablet = available <= 1180;
  const preferences = useMemo(() => parseLayout(saved), [saved]);
  const panels = {
    materials: preferences.materials ?? { open: !tablet, width: 248 },
    conversation: preferences.conversation ?? {
      open: true,
      width: tablet ? 340 : 384,
    },
  };
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState<Side | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const frame = useRef(0);
  const lastFrame = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setAvailable(entry.contentRect.width),
    );
    observer.observe(ref.current!);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      clearTimeout(settleTimer.current);
    };
  }, [ref]);

  const widths = {
    materials: Math.max(
      minimum.materials,
      Math.min(320, panels.materials.width, available - 620),
    ),
    conversation: panels.conversation.width,
  };
  // Keep enough space for reading when a desktop layout is restored on a tablet.
  widths.conversation = Math.max(
    300,
    Math.min(
      widths.conversation,
      available * 0.6,
      available - widths.materials - 320,
    ),
  );

  function beginLayoutChange() {
    clearTimeout(settleTimer.current);
    const element = ref.current!;
    const reader = element.querySelector<HTMLElement>('.reader-panel')!;
    if (reader.dataset.resizeMode === 'deferred') {
      const scale = element.getBoundingClientRect().width / element.offsetWidth;
      const width = reader.getBoundingClientRect().width / scale;
      (reader.firstElementChild as HTMLElement).style.width = `${width}px`;
    }
    element.parentElement!.dataset.layoutMoving = 'true';
  }
  function finishLayoutChange() {
    const element = ref.current!;
    (element.querySelector('.reader-panel')!.firstElementChild as HTMLElement).style.removeProperty('width');
    delete element.parentElement!.dataset.layoutMoving;
  }
  function moveDivider(side: Side, width: number) {
    const element = ref.current!;
    const next = columns(side === 'materials' ? width : panels.materials.open ? widths.materials : 0,
      side === 'conversation' ? width : panels.conversation.open ? widths.conversation : 0,
      side === 'materials' && width > 0 ? width : widths.materials);
    element.style.gridTemplateColumns = next.main.gridTemplateColumns;
    const header = element.parentElement!.querySelector<HTMLElement>('.app-header')!;
    header.style.gridTemplateColumns = next.header.gridTemplateColumns;
  }
  function updateDrag(time: number) {
    const current = dragRef.current!;
    if (time - lastFrame.current < 16) {
      frame.current = requestAnimationFrame(updateDrag);
      return;
    }
    lastFrame.current = time;
    frame.current = 0;
    moveDivider(current.side, current.width);
  }
  function settle() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishLayoutChange();
      return;
    }
    settleTimer.current = setTimeout(finishLayoutChange, duration + 32);
  }

  function maximum(side: Side) {
    const other = side === 'materials' ? 'conversation' : 'materials';
    const room = available - (side === 'conversation' || panels[other].open ? widths[other] : 0) - 320;
    return Math.max(
      minimum[side],
      Math.min(side === 'materials' ? 320 : available * 0.6, room),
    );
  }
  function save(side: Side, panel: Panel) {
    const current = localStorage.getItem(key);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...parseLayout(current),
        [side]: panel,
      }),
    );
    window.dispatchEvent(new Event('research-layout'));
  }
  function setOpen(side: Side, open: boolean) {
    if (panels[side].open === open) return;
    beginLayoutChange();
    save(side, { ...panels[side], open });
    settle();
  }
  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = dragRef.current;
    if (!current) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const open = cancelled ? panels[current.side].open : !current.closing;
    const width = cancelled ? widths[current.side] : current.width;
    moveDivider(current.side, open ? width : 0);
    if (!cancelled)
      save(current.side, {
        open: !current.closing,
        width: current.closing ? panels[current.side].width : current.width,
      });
    dragRef.current = null;
    setDragging(false);
    setClosing(null);
    if (!cancelled && current.closing) settle();
    else finishLayoutChange();
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function separator(side: Side) {
    return {
      role: 'separator' as const,
      'aria-label': side === 'materials' ? t('workspaces.resizeMaterials') : t('workspaces.resizeConversation'),
      'aria-orientation': 'vertical' as const,
      'aria-controls': `${side}-panel`,
      'aria-valuemin': minimum[side],
      'aria-valuemax': Math.round(maximum(side)),
      'aria-valuenow': Math.round(widths[side]),
      tabIndex: panels[side].open ? 0 : -1,
      hidden: !panels[side].open,
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const element = ref.current!;
        const rect = element.getBoundingClientRect();
        beginLayoutChange();
        const next = { side, width: widths[side], closing: false, left: rect.left, right: rect.right,
          scale: rect.width / element.offsetWidth, maximum: maximum(side) };
        dragRef.current = next;
        lastFrame.current = 0;
        setDragging(true);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const current = dragRef.current;
        if (current?.side !== side) return;
        const requested =
          side === 'materials'
            ? (event.clientX - current.left) / current.scale
            : (current.right - event.clientX) / current.scale;
        current.width = Math.max(minimum[side], Math.min(current.maximum, requested));
        const willClose = requested <= 48;
        if (current.closing !== willClose) setClosing(willClose ? side : null);
        current.closing = willClose;
        if (!frame.current) frame.current = requestAnimationFrame(updateDrag);
      },
      onPointerUp: finish,
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) =>
        finish(event, true),
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Enter') {
          event.preventDefault();
          setOpen(side, false);
          return;
        }
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
          return;
        event.preventDefault();
        const delta =
          (event.key === 'ArrowRight' ? 16 : -16) *
          (side === 'materials' ? 1 : -1);
        const next =
          event.key === 'Home'
            ? minimum[side]
            : event.key === 'End'
              ? maximum(side)
              : widths[side] + delta;
        beginLayoutChange();
        save(side, {
          open: true,
          width: Math.max(minimum[side], Math.min(maximum(side), next)),
        });
        settle();
      },
      onDoubleClick() {
        beginLayoutChange();
        save(side, { open: true, width: side === 'materials' ? 248 : 384 });
        settle();
      },
    };
  }
  return {
    panels,
    setOpen,
    separator,
    closing,
    dragging,
    columns: columns(panels.materials.open ? widths.materials : 0, panels.conversation.open ? widths.conversation : 0, widths.materials),
    style: {
      '--layout-duration': `${duration}ms`,
      '--materials-content-width': `${widths.materials}px`,
      '--conversation-content-width': `${widths.conversation}px`,
    } as CSSProperties,
  };
}
