import type { Phase, Status } from "../api";
import { PHASE_LABEL, STATUS_COLOR, STATUS_LABEL } from "../lib/format";

export function StatusDot({ status, size = 8 }: { status: Status; size?: number }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${STATUS_COLOR[status].bg} ${status === "running" ? "animate-pulse" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

// Text label with a dot. No pill, no fill: the dot is the only colour.
export function StatusText({ status, phase, className = "" }: { status: Status; phase?: Phase; className?: string }) {
  const label = status === "running" && phase ? PHASE_LABEL[phase] : STATUS_LABEL[status];
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <StatusDot status={status} />
      <span className={status === "running" ? "text-orange" : status === "failed" ? "text-red" : "text-label-2"}>{label}</span>
    </span>
  );
}

export function StatusBar({ counts, total, height = 4 }: { counts: Partial<Record<Status, number>>; total: number; height?: number }) {
  const order: Status[] = ["running", "queued", "completed", "failed", "lost", "cancelled"];
  return (
    <span className="flex w-full overflow-hidden rounded-full bg-fill" style={{ height }}>
      {order.map((status) => {
        const n = counts[status] ?? 0;
        if (!n) return null;
        return <span key={status} className={STATUS_COLOR[status].bg} style={{ width: `${(n / total) * 100}%` }} title={`${STATUS_LABEL[status]} ${n}`} />;
      })}
    </span>
  );
}
