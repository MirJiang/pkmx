import { cn } from "@/lib/utils";
import {
  PRIORITY_LABEL,
  STATUS_COLOR,
  STATUS_LABEL,
  type Priority,
  type Status,
} from "@/lib/types";
import { TODAY } from "@/lib/dates";

export function StatusChip({ s, className }: { s: Status; className?: string }) {
  return (
    <span
      className={cn("ink-chip", className)}
      style={{ color: STATUS_COLOR[s], borderColor: `color-mix(in srgb, ${STATUS_COLOR[s]} 35%, transparent)` }}
    >
      {STATUS_LABEL[s]}
    </span>
  );
}

export function PriorityChip({ p }: { p: Priority }) {
  if (p === "Normal") return null;
  const color =
    p === "Urgent" ? "var(--st-blocked)" : p === "High" ? "var(--warn)" : "var(--muted-foreground)";
  return (
    <span className="ink-chip" style={{ color, fontWeight: p === "Urgent" ? 600 : 400 }}>
      {PRIORITY_LABEL[p]}
    </span>
  );
}

export function DueChip({ due }: { due: string }) {
  if (!due) return null;
  const over = due < TODAY;
  const today = due === TODAY;
  const label = over ? `逾期 ${due.slice(5)}` : today ? "今天" : due.slice(5);
  return (
    <span
      className={cn("ink-chip", (over || today) && "font-semibold")}
      style={{
        color: over ? "var(--over)" : today ? "var(--st-blocked)" : "var(--warn)",
        borderColor:
          over || today
            ? "color-mix(in srgb, var(--st-blocked) 45%, transparent)"
            : "color-mix(in srgb, var(--warn) 35%, transparent)",
      }}
    >
      {label}
    </span>
  );
}

/** 任务状态小圆点（文件树/列表用） */
export function StatusDot({ s, className }: { s: Status; className?: string }) {
  return (
    <span
      className={cn("inline-block size-[7px] shrink-0 rounded-full", className)}
      style={{ background: STATUS_COLOR[s] }}
      title={STATUS_LABEL[s]}
    />
  );
}
