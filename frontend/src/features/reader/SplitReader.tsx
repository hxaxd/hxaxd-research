import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import "./reader.css";

interface Props {
  pdf: ReactNode;
  semantic: ReactNode;
}

export function clampSplitRatio(value: number) {
  return Math.min(70, Math.max(30, Math.round(value)));
}

export function splitRatioFromPointer(clientX: number, left: number, width: number) {
  if (width <= 0) return 50;
  return clampSplitRatio(((clientX - left) / width) * 100);
}

export function SplitReader({ pdf, semantic }: Props) {
  const panels = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [ratio, setRatio] = useState(50);

  function updateFromPointer(clientX: number) {
    const bounds = panels.current?.getBoundingClientRect();
    if (!bounds) return;
    setRatio(splitRatioFromPointer(clientX, bounds.left, bounds.width));
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event.clientX);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    if (dragging.current) updateFromPointer(event.clientX);
  }

  function stopDrag(event: PointerEvent<HTMLButtonElement>) {
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRatio((value) => clampSplitRatio(value - 5));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setRatio((value) => clampSplitRatio(value + 5));
    } else if (event.key === "Home") {
      event.preventDefault();
      setRatio(30);
    } else if (event.key === "End") {
      event.preventDefault();
      setRatio(70);
    }
  }

  return <div className="reader-split">
    <div className="reader-split-presets" role="toolbar" aria-label="分屏比例">
      <span>分屏比例</span>
      {[40, 50, 60].map((value) => <button
        aria-pressed={ratio === value}
        className={ratio === value ? "active" : ""}
        key={value}
        type="button"
        onClick={() => setRatio(value)}
      >{value}/{100 - value}</button>)}
    </div>
    <div
      className="reader-split-panels"
      ref={panels}
      style={{ "--reader-split-ratio": `${ratio}%` } as CSSProperties}
    >
      <div className="reader-split-panel" role="region" aria-label="PDF 版面">{pdf}</div>
      <button
        aria-label={`调整分屏比例，当前 PDF ${ratio}%`}
        aria-orientation="vertical"
        aria-valuemax={70}
        aria-valuemin={30}
        aria-valuenow={ratio}
        className="reader-split-divider"
        role="separator"
        type="button"
        onKeyDown={handleKeyboard}
        onLostPointerCapture={() => { dragging.current = false; }}
        onPointerCancel={stopDrag}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
      ><span /></button>
      <div className="reader-split-panel" role="region" aria-label="结构化双语内容">{semantic}</div>
    </div>
  </div>;
}
