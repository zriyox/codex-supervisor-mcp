import { Tooltip } from "@base-ui-components/react/tooltip";
import type { ReactElement, ReactNode } from "react";

type RenderEl = ReactElement<Record<string, unknown>>;

// A hover card in the macOS "popover" shape: a floating white panel with a
// soft shadow, no arrow, opens after a short delay. The trigger is whatever
// element is passed as `render` (a span inside a row, usually).
export function HoverCard({ render, children, side = "right" }: { render: RenderEl; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={render} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={10} align="start" collisionPadding={12} className="z-50">
          <Tooltip.Popup className="w-[380px] max-w-[calc(100vw-24px)] rounded-xl bg-bg-2 p-4 text-label shadow-panel outline-none transition-[opacity,transform] duration-150 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            {children}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function HoverProvider({ children }: { children: ReactNode }) {
  return <Tooltip.Provider delay={350} closeDelay={80}>{children}</Tooltip.Provider>;
}

export function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-2.5 first:mt-0">
      <div className="t-caption font-medium uppercase tracking-wide text-label-2">{label}</div>
      <div className="t-footnote mt-0.5 text-label">{children}</div>
    </div>
  );
}
