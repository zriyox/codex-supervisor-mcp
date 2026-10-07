import { useCallback, useEffect, useRef } from "react";

// The handle between the main column and the drawer. Dragging sets the
// drawer width; double-click puts it back to the default. The width is a
// per-viewer convenience and lives in localStorage.
const KEY = "csv.drawer.width";
export const DEFAULT_DRAWER = 0.42;
const MIN_PX = 380;
const MAX_FRACTION = 0.72;

export function readDrawerWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_DRAWER;
  } catch {
    return DEFAULT_DRAWER;
  }
}

function clamp(fraction: number) {
  const px = fraction * window.innerWidth;
  const min = MIN_PX / window.innerWidth;
  return Math.min(MAX_FRACTION, Math.max(min, px < MIN_PX ? min : fraction));
}

export function Resizer({ onChange }: { onChange: (fraction: number) => void }) {
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const fraction = clamp((window.innerWidth - e.clientX) / window.innerWidth);
      onChange(fraction);
    },
    [onChange]
  );

  const stop = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整抽屉宽度"
      title="拖动调整宽度，双击还原"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => onChange(DEFAULT_DRAWER)}
      className="group relative z-10 -mx-1 h-full w-2 shrink-0 cursor-col-resize touch-none"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-separator transition-colors group-hover:w-0.5 group-hover:bg-blue group-active:w-0.5 group-active:bg-blue" />
    </div>
  );
}
