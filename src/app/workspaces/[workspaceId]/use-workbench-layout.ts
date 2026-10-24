'use client';

import {
  useEffect,
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
type Preferences = Partial<Record<Side, Panel>>;
type Drag = { side: Side; width: number; closing: boolean };
const minimum = { materials: 200, conversation: 300 };
const key = 'research-layout';

function subscribe(listener: () => void) {
  const media = window.matchMedia('(max-width: 1180px)');
  window.addEventListener('research-layout', listener);
  window.addEventListener('storage', listener);
  media.addEventListener('change', listener);
  return () => {
    window.removeEventListener('research-layout', listener);
    window.removeEventListener('storage', listener);
    media.removeEventListener('change', listener);
  };
}

export function useWorkbenchLayout(ref: RefObject<HTMLElement | null>) {
  const saved = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key),
    () => null,
  );
  const tablet = useSyncExternalStore(
    subscribe,
    () => window.matchMedia('(max-width: 1180px)').matches,
    () => false,
  );
  const preferences: Preferences = saved ? JSON.parse(saved) : {};
  const panels = {
    materials: preferences.materials ?? { open: !tablet, width: 248 },
    conversation: preferences.conversation ?? {
      open: true,
      width: tablet ? 340 : 384,
    },
  };
  const [available, setAvailable] = useState(1400);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setAvailable(entry.contentRect.width),
    );
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, [ref]);

  const widths = {
    materials: Math.max(
      200,
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
      available - (panels.materials.open ? widths.materials : 34) - 320,
    ),
  );
  if (drag) widths[drag.side] = drag.width;

  function maximum(side: Side) {
    const other = side === 'materials' ? 'conversation' : 'materials';
    const room = available - (panels[other].open ? widths[other] : 34) - 320;
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
        ...(current ? JSON.parse(current) : {}),
        [side]: panel,
      }),
    );
    window.dispatchEvent(new Event('research-layout'));
  }
  function setOpen(side: Side, open: boolean) {
    save(side, { ...panels[side], open });
  }
  function finish(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    const current = dragRef.current;
    if (!current) return;
    if (!cancelled)
      save(current.side, {
        open: !current.closing,
        width: current.closing ? panels[current.side].width : current.width,
      });
    dragRef.current = null;
    setDrag(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function separator(side: Side) {
    return {
      role: 'separator' as const,
      'aria-label': side === 'materials' ? '调整材料栏宽度' : '调整对话栏宽度',
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
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        const next = { side, width: widths[side], closing: false };
        dragRef.current = next;
        setDrag(next);
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (dragRef.current?.side !== side) return;
        const rect = ref.current!.getBoundingClientRect();
        const requested =
          side === 'materials'
            ? event.clientX - rect.left
            : rect.right - event.clientX;
        const next = {
          side,
          width: Math.max(minimum[side], Math.min(maximum(side), requested)),
          closing: requested <= 48,
        };
        dragRef.current = next;
        setDrag(next);
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
        save(side, {
          open: true,
          width: Math.max(minimum[side], Math.min(maximum(side), next)),
        });
      },
      onDoubleClick() {
        save(side, { open: true, width: side === 'materials' ? 248 : 384 });
      },
    };
  }
  return {
    tablet,
    panels,
    setOpen,
    separator,
    closing: drag?.closing ? drag.side : null,
    dragging: Boolean(drag),
    style: {
      '--materials-width': `${panels.materials.open ? widths.materials : 34}px`,
      '--conversation-width': `${panels.conversation.open ? widths.conversation : 34}px`,
    } as CSSProperties,
  };
}
