import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "@/store";
import { fmtDate, TODAY } from "@/lib/dates";
import { renderMarkdown } from "@/lib/markdown";
import { PRIORITY_LABEL, type Issue } from "@/lib/types";
import { cn } from "@/lib/utils";
import ContextMenu from "./ContextMenu";

const KINDS = [
  { key: "daily", label: "日报" },
  { key: "weekly", label: "周报" },
  { key: "monthly", label: "月报" },
] as const;

type ReportKind = (typeof KINDS)[number]["key"];

const parseDate = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const addDays = (s: string, n: number): string => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
};

const weekdayCN = (s: string): string =>
  ["日", "一", "二", "三", "四", "五", "六"][parseDate(s).getDay()];

const periodOf = (kind: ReportKind, anchor: string) => {
  if (kind === "daily") {
    return { start: anchor, end: anchor, label: `${anchor} · 周${weekdayCN(anchor)}` };
  }
  if (kind === "weekly") {
    const dow = (parseDate(anchor).getDay() + 6) % 7; // 周一=0
    const start = addDays(anchor, -dow);
    const end = addDays(start, 6);
    return { start, end, label: `${start} ~ ${end}` };
  }
  const d = parseDate(anchor);
  const start = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1));
  const end = fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  return { start, end, label: `${d.getFullYear()}年${d.getMonth() + 1}月` };
};

const shiftAnchor = (kind: ReportKind, anchor: string, dir: number): string => {
  if (kind === "daily") return addDays(anchor, dir);
  if (kind === "weekly") return addDays(anchor, dir * 7);
  const d = parseDate(anchor);
  d.setDate(1);
  d.setMonth(d.getMonth() + dir);
  return fmtDate(d);
};

const reportTitle = (kind: ReportKind, start: string, end: string, label: string): string => {
  if (kind === "daily") return `${start} 日报`;
  if (kind === "weekly") return `${start} ~ ${end} 周报`;
  return `${label} 月报`;
};

const itemLine = (i: Issue): string =>
  `- ${i.title}${i.priority !== "Normal" ? `（${PRIORITY_LABEL[i.priority]}优先级）` : ""}`;

/** 工作报告：按日报/周报/月报周期汇总已完成（Done）的 Issue，生成可复制 Markdown */
export default function WorkReport() {
  const issues = useStore((s) => s.issues);
  const [kind, setKind] = useState<ReportKind>("daily");
  const [anchor, setAnchor] = useState(TODAY);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const { start, end, label } = periodOf(kind, anchor);
  const done = useMemo(
    () =>
      issues
        .filter((i) => i.status === "Done" && i.done && i.done >= start && i.done <= end)
        .sort((a, b) =>
          a.done! < b.done!
            ? -1
            : a.done! > b.done!
              ? 1
              : a.title.localeCompare(b.title, "zh"),
        ),
    [issues, start, end],
  );

  const markdown = useMemo(() => {
    const title = reportTitle(kind, start, end, label);
    const head = `# ${title}\n\n完成 ${done.length} 项。\n`;
    if (!done.length) return `${head}\n## 完成事项\n\n- （本周期没有已完成的任务）\n`;
    if (kind === "daily") {
      return `${head}\n## 完成事项\n\n${done.map(itemLine).join("\n")}\n`;
    }
    const days: string[] = [];
    for (const i of done) if (!days.includes(i.done!)) days.push(i.done!);
    const sections = days.map((day) => {
      const rows = done.filter((i) => i.done === day).map(itemLine).join("\n");
      return `### ${day} · 周${weekdayCN(day)}\n\n${rows}`;
    });
    return `${head}\n## 完成事项\n\n${sections.join("\n\n")}\n`;
  }, [kind, start, end, label, done]);

  const html = useMemo(() => renderMarkdown(markdown, new Set()), [markdown]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success("报告已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动选择文本");
    }
  };

  return (
    <section
      className="flex-1 overflow-y-auto bg-background"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        e.preventDefault();
        e.stopPropagation();
        setCtx({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">工作报告</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{done.length} 项已完成</span>
        </div>
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          只统计状态为「完成」的 Issue，按日报 / 周报 / 月报周期生成，可复制为 Markdown。
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-border/70">
            {KINDS.map((k) => (
              <button
                key={k.key}
                className={cn(
                  "px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                  kind === k.key && "bg-accent text-foreground",
                )}
                onClick={() => {
                  setKind(k.key);
                  setAnchor(TODAY);
                }}
              >
                {k.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1">
            <button
              className="grid size-7 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              title="上一周期"
              aria-label="上一周期"
              onClick={() => setAnchor(shiftAnchor(kind, anchor, -1))}
            >
              <ChevronLeft size={13} />
            </button>
            <span className="min-w-[185px] px-1 text-center font-mono text-[11.5px] text-muted-foreground">
              {label}
            </span>
            <button
              className="grid size-7 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              title="下一周期"
              aria-label="下一周期"
              onClick={() => setAnchor(shiftAnchor(kind, anchor, 1))}
            >
              <ChevronRight size={13} />
            </button>
            <button
              className="ml-1 flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={() => setAnchor(TODAY)}
            >
              <RotateCcw size={11} /> 本期
            </button>
          </div>

          <button
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            onClick={() => void copy()}
          >
            <Copy size={12} /> 复制报告
          </button>
        </div>

        <div className="mt-5 overflow-hidden rounded-xl border border-border/70 bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 font-mono text-[10.5px] tracking-[1.5px] text-muted-foreground">
            报告预览
            <span className="ml-auto normal-case tracking-normal">只含已完成 Issue</span>
          </div>
          <div
            className="ink-doc px-7 pb-8 pt-6"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            { label: "复制报告", onClick: () => void copy() },
            { sep: true },
            { label: "上一周期", onClick: () => setAnchor(shiftAnchor(kind, anchor, -1)) },
            { label: "下一周期", onClick: () => setAnchor(shiftAnchor(kind, anchor, 1)) },
            { label: "回到本期", disabled: anchor === TODAY, onClick: () => setAnchor(TODAY) },
          ]}
        />
      )}
    </section>
  );
}
