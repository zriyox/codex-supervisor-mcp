import { useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Tabs } from "@base-ui-components/react/tabs";

// An Apple-style segmented control over Base UI tabs. One raised pill slides
// to the selected segment (measured, not re-mounted, so it never blinks), the
// label colour crossfades, and a count sits beside the label when given.
export interface Segment<V extends string> {
  value: V;
  label: string;
  count?: number;
}

export function Segmented<V extends string>({ segments, value }: { segments: Segment<V>[]; value: V }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const el = list.querySelector<HTMLElement>(`[data-value="${CSS.escape(value)}"]`);
      if (!el) return;
      setPill({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, segments.length]);

  return (
    <Tabs.List ref={listRef} className="relative grid shrink-0 rounded-lg bg-fill p-0.5" style={{ gridTemplateColumns: `repeat(${segments.length}, minmax(0, 1fr))` }}>
      {pill && (
        <motion.span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 rounded-md bg-bg-2 shadow-[0_1px_2px_rgb(0_0_0/0.10),0_0_0_0.5px_rgb(0_0_0/0.04)]"
          initial={false}
          animate={{ left: pill.left, width: pill.width }}
          transition={{ type: "spring", stiffness: 520, damping: 42, mass: 0.7 }}
        />
      )}
      {segments.map((s) => {
        const selected = s.value === value;
        return (
          <Tabs.Tab
            key={s.value}
            value={s.value}
            data-value={s.value}
            className="t-footnote relative z-10 flex h-8 items-center justify-center gap-1 rounded-md font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue"
          >
            <motion.span animate={{ color: selected ? "var(--color-label)" : "var(--color-label-2)" }} transition={{ duration: 0.18 }} className="whitespace-nowrap">
              {s.label}
            </motion.span>
            {s.count ? <span className="tabular text-label-3">{s.count}</span> : null}
          </Tabs.Tab>
        );
      })}
    </Tabs.List>
  );
}

// Crossfade between tab panels: the leaving panel fades out while the next
// one rises in, 160 ms, no layout jump.
export function PanelFade({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={{ duration: 0.16, ease: [0.25, 0.1, 0.25, 1] }}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
