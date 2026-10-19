import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useStore, runView, saveIssuesNow } from "@/store";
import { TODAY, dateOffset } from "@/lib/dates";
import { STATUSES, STATUS_LABEL, type Issue } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DueChip, PriorityChip, StatusDot } from "./Chips";
import ContextMenu, { type CtxItem } from "./ContextMenu";

function Row({
  children,
  onClick,
  onContextMenu,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="mb-2 flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-all hover:border-primary/40 hover:shadow-sm"
    >
      {children}
    </button>
  );
}

function NewIssueButton() {
  const createIssue = useStore((s) => s.createIssue);
  const openPrompt = useStore((s) => s.openPrompt);
  return (
    <button
      className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
      onClick={() => {
        void openPrompt("新建 Issue", { placeholder: "Issue 标题…" }).then((v) => {
          if (v?.trim()) createIssue(v.trim());
        });
      }}
    >
      <Plus size={12} strokeWidth={1.8} /> 新建 Issue
    </button>
  );
}

/** 保存视图运行器：按 views/*.yml 的过滤定义渲染 Issue */
export function SavedViewRunner({ viewId }: { viewId: string | null }) {
  const issues = useStore((s) => s.issues);
  const views = useStore((s) => s.views);
  const openIssue = useStore((s) => s.openIssue);
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

  const rows = runView(issues, v);
  const groupTitle = "mb-2.5 mt-6 font-mono text-[10.5px] tracking-[2px] text-muted-foreground first:mt-0";

  const row = (n: Issue) => (
    <Row key={n.id} onClick={() => openIssue(n.id)}>
      <StatusDot s={n.status} />
      <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
      <PriorityChip p={n.priority} />
      {n.due && <DueChip due={n.due} />}
    </Row>
  );

  return (
    <section className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-5 flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">{v.name}</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length} 个 Issue</span>
          <div className="ml-auto self-center">
            <NewIssueButton />
          </div>
        </div>
        {STATUSES.filter((s) => rows.some((n) => n.status === s)).map((s) => (
          <div key={s}>
            <div className={groupTitle}>{STATUS_LABEL[s]}</div>
            {rows.filter((n) => n.status === s).map(row)}
          </div>
        ))}
        {!rows.length && (
          <div className="rounded-xl border border-dashed border-border px-6 py-8 text-center text-[13px] text-muted-foreground">
            没有满足条件的 Issue。
          </div>
        )}
      </div>
    </section>
  );
}

/** 已归档：已完成的 Issue，按归档日期筛选 */
const ARCHIVE_RANGES = [
  { key: "all", label: "全部", days: 0 },
  { key: "today", label: "当日", days: 1 },
  { key: "d7", label: "七天", days: 7 },
  { key: "d30", label: "三十天", days: 30 },
] as const;

type ArchiveRange = (typeof ARCHIVE_RANGES)[number]["key"] | "custom";

const archiveDate = (i: Issue): string => i.done ?? i.updated;

export function ArchiveView() {
  const issues = useStore((s) => s.issues);
  const openIssue = useStore((s) => s.openIssue);
  const [range, setRange] = useState<ArchiveRange>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ctx, setCtx] = useState<{ x: number; y: number; issueId: string } | null>(null);

  const chooseRange = (key: Exclude<ArchiveRange, "custom">) => {
    setRange(key);
    if (key === "all") {
      setFrom("");
      setTo("");
      return;
    }
    const days = ARCHIVE_RANGES.find((r) => r.key === key)!.days;
    setFrom(dateOffset(-(days - 1)));
    setTo(TODAY);
  };

  const setDate = (side: "from" | "to", value: string) => {
    const nextFrom = side === "from" ? value : from;
    const nextTo = side === "to" ? value : to;
    setFrom(nextFrom);
    setTo(nextTo);
    setRange(nextFrom || nextTo ? "custom" : "all");
  };

  const archived = issues
    .filter((i) => i.status === "Done")
    .filter((i) => (!from || archiveDate(i) >= from) && (!to || archiveDate(i) <= to))
    .sort((a, b) => {
      const da = archiveDate(a);
      const db = archiveDate(b);
      return da < db ? 1 : da > db ? -1 : a.title.localeCompare(b.title, "zh");
    });

  const rowMenu = (issue: Issue): CtxItem[] => {
    const s = useStore.getState();
    return [
      { label: "打开", onClick: () => s.openIssue(issue.id) },
      {
        label: "重新打开（移回看板）",
        onClick: () => {
          s.updateIssue(issue.id, { status: "Todo" });
          void saveIssuesNow();
          toast.success(`已重新打开《${issue.title}》，移回看板`);
        },
      },
      { sep: true },
      {
        label: "删除",
        danger: true,
        onClick: () => {
          void s
            .openConfirm("删除 Issue", `将删除「${issue.title}」，该操作不可恢复。`, {
              okLabel: "删除",
              danger: true,
            })
            .then((ok) => ok && s.deleteIssue(issue.id));
        },
      },
    ];
  };

  const ctxItems = (): CtxItem[] => {
    const issue = ctx ? issues.find((i) => i.id === ctx.issueId) : undefined;
    return issue ? rowMenu(issue) : [];
  };

  const seg = (active: boolean) =>
    cn(
      "px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
      active && "bg-accent text-foreground",
    );

  return (
    <section className="flex-1 overflow-y-auto bg-background">
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-4 flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">已归档任务</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">{archived.length} 个</span>
        </div>
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-border/70">
            {ARCHIVE_RANGES.map((r) => (
              <button key={r.key} className={seg(range === r.key)} onClick={() => chooseRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10.5px] text-muted-foreground">归档日期</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setDate("from", e.target.value)}
              aria-label="归档起始日期"
              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground outline-none transition-colors focus:border-primary"
            />
            <span className="text-[11px] text-muted-foreground">—</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setDate("to", e.target.value)}
              aria-label="归档结束日期"
              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground outline-none transition-colors focus:border-primary"
            />
            {(from || to) && (
              <button
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="清除日期筛选"
                aria-label="清除日期筛选"
                onClick={() => chooseRange("all")}
              >
                ×
              </button>
            )}
          </div>
        </div>
        {archived.length ? (
          archived.map((n) => (
            <Row
              key={n.id}
              onClick={() => openIssue(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtx({ x: e.clientX, y: e.clientY, issueId: n.id });
              }}
            >
              <span className="ink-seal !static !size-[18px] !rotate-0 !text-[10.5px]">讫</span>
              <span className="min-w-0 flex-1 truncate text-sm">{n.title}</span>
              <PriorityChip p={n.priority} />
              <span className="ink-chip">{archiveDate(n)}</span>
            </Row>
          ))
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">所选日期范围内没有已归档的 Issue。</p>
        )}
      </div>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={ctxItems()}
        />
      )}
    </section>
  );
}
