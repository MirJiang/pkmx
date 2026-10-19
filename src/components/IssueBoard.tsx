import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useStore, saveIssuesNow } from "@/store";
import { BOARD_STATUSES, STATUS_COLOR, STATUS_LABEL, type Issue, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DueChip, PriorityChip } from "./Chips";
import ContextMenu, { type CtxItem } from "./ContextMenu";

const DRAG_TYPE = "application/x-pkmx-issue";

type Ctx =
  | { x: number; y: number; kind: "card"; issueId: string }
  | { x: number; y: number; kind: "column"; status: Status }
  | { x: number; y: number; kind: "board" };

/** Issue 看板：只展示未归档状态，完成后自动进入已归档 */
export default function IssueBoard() {
  const issues = useStore((s) => s.issues);
  const openIssue = useStore((s) => s.openIssue);
  const updateIssue = useStore((s) => s.updateIssue);
  const createIssue = useStore((s) => s.createIssue);
  const openPrompt = useStore((s) => s.openPrompt);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<Status | null>(null);
  const [active, setActive] = useState<Status[]>(BOARD_STATUSES);
  const [ctx, setCtx] = useState<Ctx | null>(null);

  const openCount = issues.filter((i) => BOARD_STATUSES.includes(i.status)).length;
  const archivedCount = issues.length - openCount;
  const allActive = active.length === BOARD_STATUSES.length;
  const toggle = (status: Status) =>
    setActive((cur) => (cur.includes(status) ? cur.filter((s) => s !== status) : [...cur, status]));

  const add = async (status: Status) => {
    const v = await openPrompt(`新建 Issue · ${STATUS_LABEL[status]}`, {
      label: "独立于笔记，保存在 .pkmx/issues.json",
      placeholder: "Issue 标题…",
    });
    if (v?.trim()) createIssue(v.trim(), { status, open: false });
  };

  const complete = (issue: Issue) => {
    updateIssue(issue.id, { status: "Done" });
    void saveIssuesNow();
    toast.success(`已完成《${issue.title}》，自动归档`);
  };

  const cardMenu = (issue: Issue): CtxItem[] => {
    const s = useStore.getState();
    return [
      { label: "打开", onClick: () => s.openIssue(issue.id) },
      { sep: true },
      { label: "标记完成（归档）", onClick: () => complete(issue) },
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

  const columnMenu = (status: Status): CtxItem[] => [
    { label: `在「${STATUS_LABEL[status]}」新建 Issue…`, onClick: () => void add(status) },
    { sep: true },
    { label: "显示全部状态", disabled: allActive, onClick: () => setActive(BOARD_STATUSES) },
  ];

  const boardMenu = (): CtxItem[] => [
    { label: "新建 Issue…", onClick: () => void add("Todo") },
    { sep: true },
    { label: "显示全部状态", disabled: allActive, onClick: () => setActive(BOARD_STATUSES) },
  ];

  const ctxItems = (c: Ctx): CtxItem[] => {
    if (c.kind === "card") {
      const issue = issues.find((i) => i.id === c.issueId);
      return issue ? cardMenu(issue) : [];
    }
    return c.kind === "column" ? columnMenu(c.status) : boardMenu();
  };

  const drop = (status: Status, e: React.DragEvent) => {
    const id = e.dataTransfer.getData(DRAG_TYPE) || dragId;
    const issue = id ? issues.find((i) => i.id === id) : undefined;
    if (issue && issue.status !== status) {
      updateIssue(issue.id, { status });
      void saveIssuesNow();
    }
    setDragId(null);
    setOverStatus(null);
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        e.preventDefault();
        e.stopPropagation();
        setCtx({ x: e.clientX, y: e.clientY, kind: "board" });
      }}
    >
      <div className="px-8 pt-[30px]">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">Issue 看板</h2>
          <span className="font-mono text-[11.5px] text-muted-foreground">
            {openCount} 个未关闭 · {archivedCount} 个已归档
          </span>
        </div>
        <p className="mt-1.5 text-[12px] text-muted-foreground">
          拖拽卡片更新状态；右键可标记完成，归档后不再出现在看板。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[10px] tracking-[2px] text-muted-foreground">状态筛选</span>
          <button
            data-filter-status="all"
            className={cn(
              "rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] transition-colors",
              allActive
                ? "border-primary/60 bg-primary/5 text-primary"
                : "border-border/60 text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setActive(BOARD_STATUSES)}
          >
            全部
          </button>
          {BOARD_STATUSES.map((status) => {
            const on = active.includes(status);
            const count = issues.filter((i) => i.status === status).length;
            return (
              <button
                key={status}
                data-filter-status={status}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] transition-colors",
                  on
                    ? "text-foreground"
                    : "border-border/60 text-muted-foreground/60 hover:text-foreground",
                )}
                style={
                  on
                    ? {
                        borderColor: `color-mix(in srgb, ${STATUS_COLOR[status]} 45%, transparent)`,
                        background: `color-mix(in srgb, ${STATUS_COLOR[status]} 8%, transparent)`,
                      }
                    : undefined
                }
                title={on ? `隐藏${STATUS_LABEL[status]}列` : `显示${STATUS_LABEL[status]}列`}
                onClick={() => toggle(status)}
              >
                <span
                  className="size-[6px] rounded-full"
                  style={{ background: on ? STATUS_COLOR[status] : "var(--muted-foreground)" }}
                />
                {STATUS_LABEL[status]}
                <span className="opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
        {!active.length && (
          <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-border text-[13px] text-muted-foreground">
            未选择任何状态，点击上方筛选项显示对应的列。
          </div>
        )}
        {BOARD_STATUSES.filter((s) => active.includes(s)).map((status) => {
          const rows = issues.filter((i) => i.status === status);
          return (
            <div
              key={status}
              data-board-status={status}
              className={cn(
                "flex w-[230px] min-w-[210px] flex-1 flex-col rounded-xl border border-border/60 bg-card/40 transition-colors",
                dragId && overStatus === status && "border-primary/60 bg-primary/5",
              )}
              onContextMenu={(e) => {
                if ((e.target as HTMLElement).closest("[data-issue-id]")) return;
                e.preventDefault();
                e.stopPropagation();
                setCtx({ x: e.clientX, y: e.clientY, kind: "column", status });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overStatus !== status) setOverStatus(status);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setOverStatus((cur) => (cur === status ? null : cur));
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(status, e);
              }}
            >
              <div className="flex items-center gap-2 px-3 pb-2 pt-3">
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: STATUS_COLOR[status] }}
                />
                <span className="font-mono text-[10.5px] tracking-[1.5px] text-muted-foreground">
                  {STATUS_LABEL[status]}
                </span>
                <span className="font-mono text-[10.5px] text-muted-foreground/70">{rows.length}</span>
                <button
                  className="ml-auto grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                  title={`在${STATUS_LABEL[status]}列新建 Issue`}
                  aria-label={`在${STATUS_LABEL[status]}列新建 Issue`}
                  onClick={() => void add(status)}
                >
                  <Plus size={12} strokeWidth={1.8} />
                </button>
              </div>

              <div className="flex min-h-[120px] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {rows.map((issue) => (
                  <div
                    key={issue.id}
                    data-issue-id={issue.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      setDragId(issue.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(DRAG_TYPE, issue.id);
                      e.dataTransfer.setData("text/plain", issue.title);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverStatus(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtx({ x: e.clientX, y: e.clientY, kind: "card", issueId: issue.id });
                    }}
                    onClick={() => openIssue(issue.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") openIssue(issue.id);
                    }}
                    className={cn(
                      "cursor-grab rounded-lg border border-border/70 bg-card p-3 shadow-sm transition-all hover:border-primary/40 hover:shadow active:cursor-grabbing",
                      dragId === issue.id && "opacity-40",
                    )}
                  >
                    <div className="break-words text-[13.5px] leading-5">{issue.title}</div>
                    {(issue.priority !== "Normal" || issue.due || issue.done) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <PriorityChip p={issue.priority} />
                        {issue.due && <DueChip due={issue.due} />}
                        {issue.done && <span className="ink-chip">讫 {issue.done.slice(5)}</span>}
                      </div>
                    )}
                  </div>
                ))}
                {!rows.length && (
                  <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11.5px] text-muted-foreground/70">
                    拖拽到此列或点击 +
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={ctxItems(ctx)}
        />
      )}
    </section>
  );
}
