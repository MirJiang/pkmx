import { useEffect } from "react";
import { ArrowLeft, CalendarDays, Check, ChevronDown, RotateCcw, Trash2 } from "lucide-react";
import { useStore, saveIssuesNow } from "@/store";
import { PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, STATUS_COLOR, type Priority, type Status } from "@/lib/types";
import { cn } from "@/lib/utils";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="font-mono text-[10.5px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SelectWrap({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative flex items-center">
      {children}
      <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-muted-foreground" />
    </span>
  );
}

export default function IssueView() {
  const issue = useStore((s) =>
    s.activeIssueId ? s.issues.find((i) => i.id === s.activeIssueId) : undefined,
  );
  const updateIssue = useStore((s) => s.updateIssue);
  const deleteIssue = useStore((s) => s.deleteIssue);
  const openConfirm = useStore((s) => s.openConfirm);
  const setView = useStore((s) => s.setView);

  const issueId = issue?.id;
  useEffect(() => {
    if (!issueId) return;
    return () => {
      void saveIssuesNow();
    };
  }, [issueId]);

  if (!issue) {
    return (
      <section className="flex flex-1 items-center justify-center bg-background text-[13px] text-muted-foreground">
        <div className="text-center">
          <p>Issue 不存在或已被删除。</p>
          <button
            className="mt-3 inline-flex items-center gap-1.5 text-primary hover:underline"
            onClick={() => setView("board")}
          >
            <ArrowLeft size={13} /> 返回 Issue 看板
          </button>
        </div>
      </section>
    );
  }

  const closed = issue.status === "Done";
  const toggleDone = () => updateIssue(issue.id, { status: closed ? "Todo" : "Done" });

  return (
    <section className="flex-1 overflow-y-auto bg-background" data-ctx-area>
      <div className="mx-auto max-w-[860px] px-10 pb-[120px] pt-[30px]">
        <div className="mb-6 flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            onClick={() => setView("board")}
          >
            <ArrowLeft size={12} /> Issue 看板
          </button>
          <span className="font-mono text-[10.5px] text-muted-foreground">项目 Issue</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
                closed
                  ? "border-border text-muted-foreground hover:border-primary hover:text-primary"
                  : "border-primary/50 bg-primary/5 text-primary hover:bg-primary/10",
              )}
              onClick={toggleDone}
            >
              {closed ? <RotateCcw size={12} /> : <Check size={12} />}
              {closed ? "重新打开" : "标记完成"}
            </button>
            <button
              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-st-blocked hover:text-st-blocked"
              onClick={() => {
                void openConfirm("删除 Issue", `将删除「${issue.title}」，该操作不可恢复。`, {
                  okLabel: "删除",
                  danger: true,
                }).then((ok) => ok && deleteIssue(issue.id));
              }}
            >
              <Trash2 size={12} /> 删除
            </button>
          </div>
        </div>

        <input
          value={issue.title}
          onChange={(e) => updateIssue(issue.id, { title: e.target.value })}
          onBlur={() => void saveIssuesNow()}
          placeholder="Issue 标题"
          spellCheck={false}
          className="w-full border-none bg-transparent font-serif text-[30px] font-bold leading-tight outline-none placeholder:text-muted-foreground/40"
        />

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border/70 bg-card px-4 py-2.5">
          <Field label="status">
            <SelectWrap>
              <select
                value={issue.status}
                onChange={(e) => updateIssue(issue.id, { status: e.target.value as Status })}
                className="appearance-none rounded-md border border-border bg-background py-1 pl-2 pr-6 font-mono text-[11.5px] outline-none transition-colors focus:border-primary"
                style={{ color: STATUS_COLOR[issue.status] }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s} style={{ color: "var(--foreground)" }}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </SelectWrap>
          </Field>

          <Field label="priority">
            <SelectWrap>
              <select
                value={issue.priority}
                onChange={(e) => updateIssue(issue.id, { priority: e.target.value as Priority })}
                className="appearance-none rounded-md border border-border bg-background py-1 pl-2 pr-6 font-mono text-[11.5px] outline-none transition-colors focus:border-primary"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </SelectWrap>
          </Field>

          <Field label="due">
            <span className="flex items-center gap-1">
              <CalendarDays size={12} className="text-muted-foreground" />
              <input
                type="date"
                value={issue.due ?? ""}
                onChange={(e) => updateIssue(issue.id, { due: e.target.value || undefined })}
                className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11.5px] outline-none transition-colors focus:border-primary"
              />
              {issue.due && (
                <button
                  className="ml-0.5 text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => updateIssue(issue.id, { due: undefined })}
                  title="清除截止日期"
                  aria-label="清除截止日期"
                >
                  ×
                </button>
              )}
            </span>
          </Field>

          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{issue.id}</span>
        </div>

        <textarea
          value={issue.body}
          onChange={(e) => updateIssue(issue.id, { body: e.target.value })}
          onBlur={() => void saveIssuesNow()}
          placeholder="补充描述、验收标准、上下文…（支持 Markdown，随输入自动保存）"
          spellCheck={false}
          className="mt-6 min-h-[360px] w-full resize-y border-none bg-transparent font-serif text-[15px] leading-8 outline-none placeholder:font-sans placeholder:text-[13px] placeholder:text-muted-foreground/60"
        />

        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-border/60 pt-3 font-mono text-[10.5px] text-muted-foreground">
          <span>创建于 {issue.created}</span>
          <span>更新于 {issue.updated}</span>
          <span>独立存储于 .pkmx/issues.json</span>
        </div>
      </div>
    </section>
  );
}
