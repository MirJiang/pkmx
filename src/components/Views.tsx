import { useState } from "react";
import { useStore, runView } from "@/store";
import { TODAY, lastNDays } from "@/lib/dates";
import { STATUSES, STATUS_LABEL, type Note } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DueChip, PriorityChip, StatusChip, StatusDot } from "./Chips";

function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-2 flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-all hover:border-primary/40 hover:shadow-sm"
    >
      {children}
    </button>
  );
}

/** 保存视图运行器：按 views/*.yml 的过滤定义渲染结果 */
export function SavedViewRunner({ viewId }: { viewId: string | null }) {
  const notes = useStore((s) => s.notes);
  const views = useStore((s) => s.views);
  const openNote = useStore((s) => s.openNote);
  const v = views.find((x) => x.id === viewId);

  if (!v) {
    return (
      <section className="flex-1 bg-background">
        <div className="mx-auto max-w-[860px] px-10 pt-[30px] text-[13px] text-muted-foreground">
          视图不存在（可能已被删除）。
        </div>
      </section>
    );
  }

  const rows = runView(notes, v);
  const groupTitle = "mb-2.5 mt-6 font-mono text-[10.5px] tracking-[2px] text-muted-foreground first:mt-0";

  const row = (n: Note) => (
    <Row key={n.id} onClick={() => openNote(n.id)}>
      <StatusDot s={n.status!} />
      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
      {n.folder && <span className="shrink-0 text-[11.5px] text-muted-foreground">{n.folder}/</span>}
      <PriorityChip p={n.priority ?? "Normal"} />
      {n.due && <DueChip due={n.due} />}
    </Row>
  );

  return (
    <section className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-1 flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">{v.name}</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length} 篇</span>
        </div>
        <div className="mb-5" />
        {STATUSES.filter((s) => rows.some((n) => n.status === s)).map((s) => (
          <div key={s}>
            <div className={groupTitle}>{STATUS_LABEL[s]}</div>
            {rows.filter((n) => n.status === s).map(row)}
          </div>
        ))}
        {!rows.length && (
          <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-[13px] text-muted-foreground">
            没有满足条件的笔记。
          </div>
        )}
      </div>
    </section>
  );
}

/** 未完成：所有未关闭任务，按截止时间分桶 */
export function OpenView() {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);

  const open = notes.filter((n) => n.status && !["Done", "Wont"].includes(n.status));
  const byDue = (a: Note, b: Note) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : a.title.localeCompare(b.title, "zh"));
  const over = open.filter((n) => n.due && n.due < TODAY).sort(byDue);
  const today = open.filter((n) => n.due === TODAY);
  const future = open.filter((n) => n.due && n.due > TODAY).sort(byDue);
  const none = open.filter((n) => !n.due).sort((a, b) => a.title.localeCompare(b.title, "zh"));

  const groupTitle = "mb-2.5 mt-6 font-mono text-[10.5px] tracking-[2px] text-muted-foreground first:mt-0";
  const row = (n: Note) => (
    <Row key={n.id} onClick={() => openNote(n.id)}>
      <StatusDot s={n.status!} />
      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
      {n.folder && <span className="shrink-0 text-[11.5px] text-muted-foreground">{n.folder}/</span>}
      <PriorityChip p={n.priority ?? "Normal"} />
      <DueChip due={n.due!} />
    </Row>
  );
  const group = (label: string, rows: Note[]) =>
    rows.length ? (
      <div>
        <div className={groupTitle}>{label}</div>
        {rows.map(row)}
      </div>
    ) : null;

  return (
    <section className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-5 flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">未完成</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{open.length} 个任务</span>
        </div>
        {group("已逾期", over)}
        {group("今天到期", today)}
        {group("未来", future)}
        {group("无截止日期", none)}
        {!open.length && <p className="px-1 py-2 text-xs text-muted-foreground">没有未关闭的任务。</p>}
      </div>
    </section>
  );
}

/** 已完成：done 落在所选时间范围内的任务（当日 / 七天 / 三十天） */
const DONE_RANGES = [
  { key: "today", label: "当日", days: 1 },
  { key: "d7", label: "七天", days: 7 },
  { key: "d30", label: "三十天", days: 30 },
] as const;

export function DoneView() {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);
  const [range, setRange] = useState<(typeof DONE_RANGES)[number]["key"]>("d7");

  const days = DONE_RANGES.find((r) => r.key === range)!.days;
  const within = lastNDays(days);
  const done = notes
    .filter((n) => n.status && n.done && within.includes(n.done))
    .sort((a, b) => (a.done! < b.done! ? 1 : -1));

  return (
    <section className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-5 flex items-center gap-3">
          <h2 className="font-serif text-2xl font-bold">已完成</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{done.length} 个</span>
          <div className="ml-auto flex overflow-hidden rounded-lg border border-border/70">
            {DONE_RANGES.map((r) => (
              <button
                key={r.key}
                className={cn(
                  "px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  range === r.key && "bg-accent text-foreground",
                )}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {done.length ? (
          done.map((n) => (
            <Row key={n.id} onClick={() => openNote(n.id)}>
              <span className="ink-seal !static !size-[18px] !rotate-0 !text-[10.5px]">讫</span>
              <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
              {n.folder && <span className="shrink-0 text-[11.5px] text-muted-foreground">{n.folder}/</span>}
              <StatusChip s={n.status!} />
              <span className="ink-chip">{n.done}</span>
            </Row>
          ))
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">所选范围内没有完成的任务。</p>
        )}
      </div>
    </section>
  );
}
