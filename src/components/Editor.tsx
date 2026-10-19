import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderInput, Pin, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useStore, getVault, getAttachmentUrl, revealNoteInExplorer } from "@/store";
import { isTauri } from "@/lib/vault";
import { renderMarkdown, splitBlocks, joinBlocks, countTasks, type MdBlock } from "@/lib/markdown";
import { TODAY } from "@/lib/dates";
import { PRIORITY_LABEL, STATUSES, STATUS_COLOR, STATUS_LABEL, type Note, type Status } from "@/lib/types";
import { DueChip, PriorityChip, StatusDot } from "./Chips";
import ContextMenu from "./ContextMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ---------- 属性条 ---------- */
const EMPTY: string[] = [];

function PropsBar({ note }: { note: Note }) {
  const setStatus = useStore((s) => s.setStatus);
  const cyclePriority = useStore((s) => s.cyclePriority);
  const setDue = useStore((s) => s.setDue);
  const unTask = useStore((s) => s.unTask);
  const taskToCheckbox = useStore((s) => s.taskToCheckbox);
  const isTask = Boolean(note.status);
  const isDaily = Boolean(note.date);

  if (!isTask && !isDaily) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-1.5 rounded-xl border border-dashed border-border bg-secondary/60 px-3 py-2 font-mono text-[11px]">
      {note.status && (
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-1.5 rounded px-1 py-0.5 text-secondary-foreground transition-colors hover:bg-accent">
            <span className="text-muted-foreground">status:</span>
            <span style={{ color: STATUS_COLOR[note.status] }}>{STATUS_LABEL[note.status]}</span>
            <ChevronDown size={9} className="opacity-50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {STATUSES.map((s: Status) => (
              <DropdownMenuItem key={s} onClick={() => setStatus(note.id, s)}>
                <span
                  className="inline-block size-[7px] rounded-full"
                  style={{ background: STATUS_COLOR[s] }}
                />
                {STATUS_LABEL[s]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {note.priority && (
        <button
          className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent"
          onClick={() => cyclePriority(note.id)}
          title="点击切换优先级"
        >
          <span className="text-muted-foreground">priority:</span>
          <span className="text-foreground">{PRIORITY_LABEL[note.priority]}</span>
        </button>
      )}
      {note.status && (
        <label className="flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-accent">
          <span className="text-muted-foreground">due:</span>
          <input
            type="date"
            value={note.due ?? ""}
            onChange={(e) => setDue(note.id, e.target.value)}
            className="border-none bg-transparent p-0 font-mono text-[11px] text-foreground outline-none"
          />
        </label>
      )}
      {note.date && (
        <span className="flex items-center gap-1.5 px-1 py-0.5">
          <span className="text-muted-foreground">date:</span>
          <span className="text-foreground">{note.date}</span>
        </span>
      )}
      {isTask && (
        <>
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => taskToCheckbox(note.id)}
            title="把这条任务变成今日笔记里的一个勾选项"
          >
            ⇩ 转为今日勾选项
          </button>
          <button
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => unTask(note.id)}
            title="移除任务属性"
          >
            × 取消任务
          </button>
        </>
      )}
    </div>
  );
}

/* ---------- Daily 自动聚合区 ---------- */
function DailyInjections({ note }: { note: Note }) {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);
  const pinInjection = useStore((s) => s.pinInjection);
  // 注意：selector 必须返回稳定引用（zustand v5 用 Object.is 比较），?? [] 要放在外面
  const pinnedAll = useStore((s) => s.pinnedInjections);
  const pinned = pinnedAll[note.id] ?? EMPTY;
  const [tick, setTick] = useState(0);

  const due = notes
    .filter((n) => n.status && n.due && n.due <= TODAY && !["Done", "Wont"].includes(n.status))
    .sort((a, b) => (a.due! < b.due! ? -1 : 1));
  const done = notes.filter((n) => n.status && n.done === TODAY);

  const row = (n: Note) => (
    <button
      key={n.id}
      onClick={() => openNote(n.id)}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left transition-colors hover:bg-accent"
    >
      <StatusDot s={n.status!} />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{n.title}</span>
      <PriorityChip p={n.priority!} />
      <DueChip due={n.due!} />
    </button>
  );

  const block = (which: "due" | "done", title: string, rows: React.ReactNode, empty: string) => {
    const isPinned = pinned.includes(which);
    return (
      <div className="mb-5 overflow-hidden rounded-xl border border-dashed border-daily/45">
        <div
          className="flex items-center gap-2 px-3.5 py-2"
          style={{ background: "color-mix(in srgb, var(--daily) 7%, transparent)" }}
        >
          <h4 className="text-[12.5px] font-bold tracking-wide text-daily">{title}</h4>
          <span className="rounded-full border border-daily/40 px-1.5 py-px font-mono text-[9.5px] text-daily">
            {isPinned ? "已固化" : "自动聚合"}
          </span>
          {!isPinned && (
            <>
              <button
                className="ml-auto grid size-5 place-items-center rounded text-daily opacity-65 transition-opacity hover:opacity-100"
                onClick={() => {
                  setTick((t) => t + 1);
                  toast("注入区已按文件系统重新聚合");
                }}
                title="重新聚合"
                aria-label="重新聚合"
              >
                <RefreshCw size={12} strokeWidth={1.6} />
              </button>
              <button
                className="grid size-5 place-items-center rounded text-daily opacity-65 transition-opacity hover:opacity-100"
                onClick={() => pinInjection(note.id, which)}
                title="把当前结果固化为正文静态文本"
                aria-label="固化"
              >
                <Pin size={12} strokeWidth={1.6} />
              </button>
            </>
          )}
        </div>
        <div className="px-2.5 pb-2.5 pt-1.5">
          {rows ?? <div className="px-2 py-2 text-[12.5px] text-muted-foreground">{empty}</div>}
        </div>
      </div>
    );
  };

  return (
    <div key={tick}>
      {block("due", "今日到期", due.map(row), "今天没有到期的任务。")}
      {block("done", "今日完成", done.map(row), "今天还没有完成的任务。")}
    </div>
  );
}

/* ---------- 右栏：大纲 + 反向链接 ---------- */
function RightRail({
  note,
  containerRef,
}: {
  note: Note;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);

  const heads = useMemo(
    () =>
      (note.body.match(/^#{2,6}\s+.+$/gm) ?? []).map((h) => ({
        lv: h.match(/^#+/)![0].length,
        t: h.replace(/^#+\s+/, ""),
      })),
    [note.body],
  );
  const backlinks = useMemo(
    () => notes.filter((n) => n.id !== note.id && n.body.includes(`[[${note.title}]]`)),
    [notes, note.id, note.title],
  );

  return (
    <aside className="hidden w-[264px] shrink-0 overflow-y-auto border-l border-border bg-sidebar p-3 [@media(min-width:1180px)]:block">
      <section className="mb-5">
        <h5 className="mb-2 ml-1 font-mono text-[10px] tracking-[2px] text-muted-foreground">大纲</h5>
        {heads.length ? (
          heads.map((h, i) => (
            <button
              key={i}
              className={cn(
                "block w-full truncate rounded-md px-2.5 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                h.lv === 3 && "pl-6 text-xs",
              )}
              onClick={() => {
                const el = [...(containerRef.current?.querySelectorAll("h2,h3") ?? [])].find(
                  (e) => e.textContent === h.t,
                );
                el?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              {h.t}
            </button>
          ))
        ) : (
          <p className="px-2 text-xs text-muted-foreground">暂无标题结构</p>
        )}
      </section>
      <section>
        <h5 className="mb-2 ml-1 font-mono text-[10px] tracking-[2px] text-muted-foreground">
          反向链接 · {backlinks.length}
        </h5>
        {backlinks.length ? (
          backlinks.map((b) => {
            const idx = b.body.indexOf(`[[${note.title}]]`);
            const snip = b.body.slice(Math.max(0, idx - 30), idx).replace(/\n/g, " ");
            return (
              <button
                key={b.id}
                onClick={() => openNote(b.id)}
                className="mb-1.5 block w-full rounded-md border border-border/70 bg-card px-2.5 py-2 text-left transition-colors hover:border-primary"
              >
                <div className="mb-0.5 truncate text-[12.5px] font-medium">{b.title}</div>
                <div className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">…{snip}</div>
              </button>
            );
          })
        ) : (
          <p className="px-2 text-xs text-muted-foreground">暂无入链</p>
        )}
      </section>
    </aside>
  );
}

/* ---------- 源码模式（整文件编辑 + [[ 补全 + 粘贴图片） ---------- */

function caretPos(ta: HTMLTextAreaElement): { x: number; y: number } {  const div = document.createElement("div");
  const cs = getComputedStyle(ta);
  for (const p of [
    "fontFamily",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "paddingTop",
    "paddingLeft",
    "paddingRight",
    "width",
    "boxSizing",
  ] as const) {
    div.style[p] = cs[p];
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  div.appendChild(marker);
  document.body.appendChild(div);
  const x = marker.offsetLeft - ta.scrollLeft;
  const y = marker.offsetTop - ta.scrollTop;
  div.remove();
  return { x, y };
}

/** 整文件原文（frontmatter + 正文），源码模式编辑的就是它 */
function fullText(note: Note): string {
  const lines: string[] = [];
  if (note.status) lines.push(`status: ${note.status}`);
  if (note.priority) lines.push(`priority: ${note.priority}`);
  if (note.status && note.due) lines.push(`due: ${note.due}`);
  if (note.done) lines.push(`done: ${note.done}`);
  if (note.date) lines.push(`date: ${note.date}`);
  if (note.created) lines.push(`created: ${note.created}`);
  if (!lines.length) return note.body;
  return `---\n${lines.join("\n")}\n---\n` + note.body;
}

function SourceEditor({ note }: { note: Note }) {
  const notes = useStore((s) => s.notes);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [wl, setWl] = useState<{ query: string; start: number } | null>(null);
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 24, y: 24 });
  /** 本地持有整文件原文，防 frontmatter 半成品被序列化回写打断 */
  const rawRef = useRef(fullText(note));
  const flushTimer = useRef<number | null>(null);

  const commit = (text: string, immediate = false) => {
    rawRef.current = text;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    if (immediate) useStore.getState().updateRaw(note.id, text);
    else flushTimer.current = window.setTimeout(() => useStore.getState().updateRaw(note.id, text), 600);
  };

  useEffect(() => {
    rawRef.current = fullText(note);
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id]);

  const matches = useMemo(() => {
    if (!wl) return [];
    const q = wl.query.trim().toLowerCase();
    return notes
      .filter((n) => n.title.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => n.title);
  }, [wl, notes]);

  useEffect(() => setSel(0), [wl?.query]);

  const detect = (ta: HTMLTextAreaElement) => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/\[\[([^\][\n]*)$/);
    if (m) {
      setWl({ query: m[1], start: ta.selectionStart - m[1].length - 2 });
      const p = caretPos(ta);
      setPos({ x: p.x + 44, y: p.y + 32 });
    } else {
      setWl(null);
    }
  };

  const insertAt = (insert: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const next = ta.value.slice(0, s) + insert + ta.value.slice(ta.selectionEnd);
    ta.value = next;
    const at = s + insert.length;
    ta.setSelectionRange(at, at);
    commit(next);
    requestAnimationFrame(() => ta.focus());
  };

  const insertLink = (title: string) => {
    const ta = taRef.current;
    if (!ta || !wl) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, wl.start);
    const after = ta.value.slice(caret);
    const next = `${before}[[${title}]]${after}`;
    ta.value = next;
    const at = before.length + title.length + 4;
    ta.setSelectionRange(at, at);
    commit(next);
    setWl(null);
    requestAnimationFrame(() => ta.focus());
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    const dataUrl = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
    try {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const rel = await useStore.getState().writeAttachment(dataUrl, ext);
      insertAt(`![](${rel})`);
      toast.success(`图片已保存到 ${rel}`);
    } catch (err) {
      toast.error("图片保存失败", { description: String(err) });
    }
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex gap-3.5 border-b border-border/70 px-[18px] py-2 font-mono text-[10.5px] text-muted-foreground">
        <span>源码模式 — 直接编辑 Markdown 文件（含 frontmatter）</span>
        <span>输入 [[ 双链补全 · 粘贴图片自动存附件</span>
      </div>
      <textarea
        ref={taRef}
        defaultValue={rawRef.current}
        key={note.id}
        spellCheck={false}
        placeholder={"---\nstatus: Todo\n---\n\n# 标题\n\n正文支持 [[双链]]、- [ ] 任务、**加粗**、> 引用…"}
        onPaste={(e) => void onPaste(e)}
        onChange={(e) => {
          commit(e.target.value);
          detect(e.target);
        }}
        onBlur={() => commit(rawRef.current, true)}
        onClick={(e) => detect(e.currentTarget)}
        onKeyDown={(e) => {
          if (wl && matches.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => (s + 1) % matches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => (s - 1 + matches.length) % matches.length);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              insertLink(matches[sel]);
              return;
            }
          }
          if (e.key === "Escape" && wl) {
            e.preventDefault();
            setWl(null);
          }
        }}
        className="min-h-0 flex-1 resize-none border-none bg-transparent px-11 py-5 font-mono text-[13px] leading-[1.8] text-foreground outline-none"
      />
      {wl && matches.length > 0 && (
        <div
          className="absolute z-30 min-w-[220px] rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{ left: pos.x, top: pos.y }}
        >
          {matches.map((t, i) => (
            <button
              key={t}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px]",
                i === sel ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // 不让 textarea 失焦
                insertLink(t);
              }}
              onMouseEnter={() => setSel(i)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 块编辑模式（分块渲染，点击块就地编辑源码） ---------- */

const autosize = (ta: HTMLTextAreaElement) => {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight}px`;
};

function BlockEditor({
  note,
  titles,
  containerRef,
}: {
  note: Note;
  titles: Set<string>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const notes = useStore((s) => s.notes);
  const wide = useStore((s) => s.wide);
  const toggleTask = useStore((s) => s.toggleTask);
  const checkboxToTask = useStore((s) => s.checkboxToTask);
  const openOrCreateByTitle = useStore((s) => s.openOrCreateByTitle);
  const confirmCreate = useStore((s) => s.confirmCreate);
  const toTask = useStore((s) => s.toTask);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** 正在编辑的块（按起始行标识；-1 = 末尾追加新块） */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [wl, setWl] = useState<{ query: string; start: number } | null>(null);
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState({ x: 24, y: 24 });

  const blocks = useMemo(() => splitBlocks(note.body), [note.body]);
  const rendered = useMemo(() => {
    let off = 0;
    return blocks.map((b) => {
      const html = renderMarkdown(b.raw, titles, off);
      off += countTasks(b.raw);
      return { b, html };
    });
  }, [blocks, titles]);

  useEffect(() => {
    const ta = taRef.current;
    if (editing !== null && ta) {
      ta.focus();
      autosize(ta);
      const len = ta.value.length;
      ta.setSelectionRange(len, len);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  useEffect(() => setSel(0), [wl?.query]);

  const matches = useMemo(() => {
    if (!wl) return [];
    const q = wl.query.trim().toLowerCase();
    return notes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8).map((n) => n.title);
  }, [wl, notes]);

  const startEdit = (b: MdBlock) => {
    setDraft(b.raw);
    setWl(null);
    setEditing(b.start);
  };

  const newBlock = () => {
    setDraft("");
    setWl(null);
    setEditing(-1);
  };

  const commit = () => {
    if (editing === null) return;
    if (editing === -1) {
      if (draft.trim()) {
        const base = joinBlocks(note.body, new Map()).trimEnd();
        useStore.getState().updateBody(note.id, base ? `${base}\n\n${draft}\n` : `${draft}\n`);
      }
    } else {
      useStore.getState().updateBody(note.id, joinBlocks(note.body, new Map([[editing, draft]])));
    }
    setEditing(null);
    setWl(null);
  };

  /** 光标处 [[ 补全；弹窗定位到当前行下方 */
  const detect = (ta: HTMLTextAreaElement) => {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/\[\[([^\][\n]*)$/);
    if (!m) {
      setWl(null);
      return;
    }
    setWl({ query: m[1], start: ta.selectionStart - m[1].length - 2 });
    const lineIdx = upto.split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    setPos({ x: ta.offsetLeft + 10, y: ta.offsetTop + (lineIdx + 1) * lh + 8 });
  };

  const insertAt = (insert: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    setDraft(ta.value.slice(0, s) + insert + ta.value.slice(ta.selectionEnd));
    requestAnimationFrame(() => {
      const at = s + insert.length;
      ta.setSelectionRange(at, at);
      autosize(ta);
      ta.focus();
    });
  };

  const insertLink = (title: string) => {
    const ta = taRef.current;
    if (!ta || !wl) return;
    const caret = ta.selectionStart;
    const before = ta.value.slice(0, wl.start);
    const after = ta.value.slice(caret);
    setDraft(`${before}[[${title}]]${after}`);
    setWl(null);
    requestAnimationFrame(() => {
      ta.setSelectionRange(before.length + title.length + 4, before.length + title.length + 4);
      ta.focus();
    });
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    const dataUrl = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsDataURL(file);
    });
    try {
      const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const rel = await useStore.getState().writeAttachment(dataUrl, ext);
      insertAt(`![](${rel})`);
      toast.success(`图片已保存到 ${rel}`);
    } catch (err) {
      toast.error("图片保存失败", { description: String(err) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (wl && matches.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        insertLink(matches[sel]);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (wl) setWl(null);
      else setEditing(null); // 放弃修改
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      insertAt("  ");
    }
  };

  /** 与阅读模式同一套事件委托：勾选/转任务/双链 + 块点击进入编辑 */
  const onDocClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const toTaskBtn = el.closest("button[data-to-task]");
    if (toTaskBtn) {
      checkboxToTask(note.id, +(toTaskBtn as HTMLElement).dataset.toTask!);
      return;
    }
    const task = el.closest("input[data-task]") as HTMLInputElement | null;
    if (task) {
      toggleTask(note.id, +task.dataset.task!);
      return;
    }
    const wlink = el.closest("[data-wikilink]") as HTMLElement | null;
    if (wlink) {
      const name = wlink.getAttribute("data-wikilink")!;
      if (titles.has(name)) openOrCreateByTitle(name);
      else confirmCreate(name);
      return;
    }
    if (editing !== null) return; // 编辑中点别处：textarea blur 已先行提交
    const blk = el.closest("[data-bstart]") as HTMLElement | null;
    if (blk) {
      const b = blocks.find((x) => x.start === +blk.dataset.bstart!);
      if (b) startEdit(b);
    }
  };

  const esc2 = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const createdAt = note.created ? ` · 创建于 ${note.created}` : "";
  const editTa =
    editing !== null ? (
      <textarea
        ref={taRef}
        className="ink-block-edit"
        value={draft}
        spellCheck={false}
        placeholder="空行分段，支持 [[双链]]、- [ ] 任务、**加粗**、> 引用、``` 代码块…（Ctrl+Enter 完成，Esc 取消）"
        onChange={(e) => {
          setDraft(e.target.value);
          autosize(e.target);
          detect(e.target);
        }}
        onKeyDown={onKeyDown}
        onBlur={commit}
        onPaste={(e) => void onPaste(e)}
      />
    ) : null;

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto">
      <article className={cn("mx-auto px-11 pb-[120px] pt-6", wide ? "max-w-[980px]" : "max-w-[720px]")}>
        <PropsBar note={note} />
        {note.date && <DailyInjections note={note} />}
        <div className="ink-doc" onClick={onDocClick}>
          <h1>{esc2(note.title)}</h1>
          <div className="sub-line">{esc2(`${note.fileName}${createdAt}`)}</div>
          {rendered.map(({ b, html }) =>
            editing === b.start ? (
              <div key={`e${b.start}`}>{editTa}</div>
            ) : (
              <div key={b.start} className="ink-block" data-bstart={b.start} dangerouslySetInnerHTML={{ __html: html }} />
            ),
          )}
          {editing === -1 ? (
            editTa
          ) : (
            <button
              className="mx-auto mt-8 flex rounded-full border border-dashed border-border bg-card px-4 py-[7px] text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
              onClick={newBlock}
            >
              ＋ 新段落
            </button>
          )}
        </div>
        {!note.status && !note.date && (
          <button
            className="mx-auto mt-8 flex rounded-full border border-dashed border-border bg-card px-4 py-[7px] text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
            onClick={() => toTask(note.id)}
          >
            ＋ 转为任务（添加 status 属性，进入未完成）
          </button>
        )}
      </article>
      {wl && matches.length > 0 && (
        <div
          className="absolute z-30 min-w-[220px] rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{ left: pos.x, top: pos.y }}
        >
          {matches.map((t, i) => (
            <button
              key={t}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px]",
                i === sel ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              )}
              onMouseDown={(e) => {
                e.preventDefault(); // 不让 textarea 失焦
                insertLink(t);
              }}
              onMouseEnter={() => setSel(i)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 移动到文件夹 ---------- */
function MoveMenu({ note }: { note: Note }) {
  const notes = useStore((s) => s.notes);
  const moveNote = useStore((s) => s.moveNote);
  const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort().filter((f) => f !== note.folder);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1 rounded-md px-2 py-[5px] text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="移动到文件夹"
      >
        <FolderInput size={12} strokeWidth={1.5} />
        移动
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!note.folder} onClick={() => moveNote(note.id, "")}>
          根目录
        </DropdownMenuItem>
        {folders.map((f) => (
          <DropdownMenuItem key={f} onClick={() => moveNote(note.id, f)}>
            {f}/
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---------- 主编辑器 ---------- */
export default function Editor({ noteId }: { noteId: string }) {
  const notes = useStore((s) => s.notes);
  const note = notes.find((n) => n.id === noteId);
  const editMode = useStore((s) => s.editMode);
  const wide = useStore((s) => s.wide);
  const setEditMode = useStore((s) => s.setEditMode);
  const toggleWide = useStore((s) => s.toggleWide);
  const toggleTask = useStore((s) => s.toggleTask);
  const checkboxToTask = useStore((s) => s.checkboxToTask);
  const openOrCreateByTitle = useStore((s) => s.openOrCreateByTitle);
  const confirmCreate = useStore((s) => s.confirmCreate);
  const toTask = useStore((s) => s.toTask);
  const moveNote = useStore((s) => s.moveNote);
  const renameNote = useStore((s) => s.renameNote);
  const deleteNote = useStore((s) => s.deleteNote);
  const openPrompt = useStore((s) => s.openPrompt);
  const linkSelection = useStore((s) => s.linkSelection);

  const containerRef = useRef<HTMLDivElement>(null);
  const titles = useMemo(() => new Set(notes.map((n) => n.title)), [notes]);
  /** 阅读模式选区 → 浮动"转为双链"按钮 */
  const [selLink, setSelLink] = useState<{ x: number; y: number; text: string } | null>(null);
  /** 正文右键菜单 */
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const onAreaContextMenu = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, [contenteditable='true']")) return; // 输入处保留原生（粘贴）
    e.preventDefault();
    e.stopPropagation(); // 接管 App 级默认菜单
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const areaMenuItems = (): { label?: string; onClick?: () => void; danger?: boolean; sep?: boolean }[] => {
    const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort().filter((f) => f !== note?.folder);
    const items: { label?: string; onClick?: () => void; danger?: boolean; sep?: boolean }[] = [
      {
        label: "重命名…",
        onClick: () => void doRename(),
      },
    ];
    if (folders.length || note?.folder) {
      items.push({ sep: true, label: "移动到" });
      if (note?.folder) items.push({ label: "· 根目录", onClick: () => note && moveNote(note.id, "") });
      for (const f of folders.slice(0, 8)) items.push({ label: `· ${f}/`, onClick: () => note && moveNote(note.id, f) });
    }
    items.push({ sep: true }, { label: "删除", danger: true, onClick: doDelete });
    if (isTauri() && note) {
      items.push({ sep: true }, { label: "在资源管理器中显示", onClick: () => void revealNoteInExplorer(note) });
    }
    return items;
  };

  const onDocMouseUp = () => {
    const sel = window.getSelection();
    const container = containerRef.current;
    if (!sel || sel.isCollapsed || !container || !sel.anchorNode || !container.contains(sel.anchorNode)) {
      setSelLink(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim() || text.includes("\n") || text.includes("[[") || text.length > 80) {
      setSelLink(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = container.getBoundingClientRect();
    setSelLink({ x: rect.left - box.left + container.scrollLeft, y: rect.top - box.top + container.scrollTop - 36, text });
  };

  const html = useMemo(() => (note ? renderMarkdown(note.body, titles) : ""), [note, titles]);

  /** 渲染后为仓库内图片回填 dataURL（阅读/块模式共用） */
  useEffect(() => {
    if (editMode === "source") return;
    const imgs = [...(containerRef.current?.querySelectorAll<HTMLImageElement>("img[data-att]:not([src])") ?? [])];
    for (const img of imgs) {
      const rel = img.dataset.att!;
      void getAttachmentUrl(rel).then((url) => {
        if (url) img.src = url;
        else img.replaceWith(Object.assign(document.createElement("span"), { textContent: `[图片缺失：${rel}]`, className: "text-[11px] text-st-blocked" }));
      });
    }
  }, [html, editMode]);

  if (!note) {
    return (
      <div className="grid flex-1 place-items-center text-muted-foreground">
        <p className="text-[13px]">笔记不存在（可能已被移动或删除）。</p>
      </div>
    );
  }

  const onDocClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const toTaskBtn = el.closest("button[data-to-task]");
    if (toTaskBtn) {
      checkboxToTask(note.id, +(toTaskBtn as HTMLElement).dataset.toTask!);
      return;
    }
    const task = el.closest("input[data-task]") as HTMLInputElement | null;
    if (task) {
      toggleTask(note.id, +task.dataset.task!);
      return;
    }
    const wl = el.closest("[data-wikilink]") as HTMLElement | null;
    if (wl) {
      const name = wl.getAttribute("data-wikilink")!;
      if (titles.has(name)) openOrCreateByTitle(name);
      else confirmCreate(name); // 未解析：先确认再创建
    }
  };

  const doRename = async () => {
    const v = await openPrompt("重命名文件", {
      label: `当前：${note.fileName}（仅改文件名，不改标题；标题取自正文第一个 # 一级标题）`,
      value: note.fileName.replace(/\.md$/i, ""),
      placeholder: "新文件名（不含 .md）",
    });
    if (v && v.trim()) renameNote(note.id, v.trim());
  };

  const doDelete = () => {
    void useStore.getState()
      .openConfirm("删除文件", `将删除本地文件「${note.fileName}」，该操作不可恢复。`, { okLabel: "删除", danger: true })
      .then((ok) => ok && deleteNote(note.id));
  };

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const createdAt = note.created ? ` · 创建于 ${note.created}` : "";

  return (
    <div className="flex min-w-0 flex-1 bg-background" onContextMenu={onAreaContextMenu}>
      <section className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <div className="flex items-center gap-1.5 border-b border-border/70 px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">{getVault().rootName}</span>
            {note.folder && (
              <>
                <span className="opacity-50">/</span>
                <span className="shrink-0">{note.folder}</span>
              </>
            )}
            <span className="opacity-50">/</span>
            <button
              className="truncate rounded border border-border/70 bg-secondary px-[7px] py-0.5 font-mono text-[11px] text-secondary-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={() => void doRename()}
              title="点击重命名文件"
            >
              {note.fileName}
            </button>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <MoveMenu note={note} />
            <button
              className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-st-blocked"
              onClick={doDelete}
              title="删除笔记"
              aria-label="删除笔记"
            >
              <Trash2 size={13} strokeWidth={1.5} />
            </button>
            <div className="flex overflow-hidden rounded-md border border-border/70">
              {([["read", "阅读"], ["block", "块"], ["source", "源码"]] as const).map(([m, label]) => (
                <button
                  key={m}
                  className={cn(
                    "px-2.5 py-[5px] text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    editMode === m && "bg-accent text-foreground",
                  )}
                  onClick={() => setEditMode(m)}
                  title={m === "block" ? "块编辑：点击段落就地编辑" : m === "source" ? "源码模式：整文件直编" : "阅读模式"}
                >
                  {label}
                </button>
              ))}
            </div>
            <kbd className="rounded border border-border px-1 font-mono text-[9.5px] text-muted-foreground">Ctrl \</kbd>
            <button
              className={cn(
                "rounded-md px-2 py-[5px] text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                wide && "bg-accent text-foreground",
              )}
              onClick={toggleWide}
              title="宽版排版"
            >
              宽
            </button>
          </div>
        </div>

        {/* 滚动区：属性条 + 正文（阅读 / 块编辑 / 源码三态） */}
        {editMode === "source" ? (
          <SourceEditor note={note} key={note.id} />
        ) : editMode === "block" ? (
          <BlockEditor note={note} titles={titles} containerRef={containerRef} key={note.id} />
        ) : (
          <div ref={containerRef} className="relative min-h-0 flex-1 overflow-y-auto" onMouseUp={onDocMouseUp}>
            <article
              className={cn("mx-auto px-11 pb-[120px] pt-6", wide ? "max-w-[980px]" : "max-w-[720px]")}
              onDoubleClick={(e) => {
                // 阅读区双击（非交互元素）快速进入源码编辑
                if (!(e.target as HTMLElement).closest("input,button,.ink-wl,img")) setEditMode("source");
              }}
            >
              <PropsBar note={note} />
              {note.date && <DailyInjections note={note} />}
              <div
                className="ink-doc"
                onClick={onDocClick}
                dangerouslySetInnerHTML={{
                  __html: `<h1>${esc(note.title)}</h1><div class="sub-line">${esc(`${note.fileName}${createdAt}`)}</div>${html}`,
                }}
              />
              {!note.status && !note.date && (
                <button
                  className="sticky bottom-6 mx-auto mt-8 flex rounded-full border border-dashed border-border bg-card px-4 py-[7px] text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary"
                  onClick={() => toTask(note.id)}
                >
                  ＋ 转为任务（添加 status 属性，进入未完成）
                </button>
              )}
            </article>
            {selLink && (
              <button
                className="absolute z-20 flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1 text-[11.5px] text-primary shadow-md"
                style={{ left: selLink.x, top: selLink.y }}
                onMouseDown={(e) => {
                  e.preventDefault(); // 不清除选区
                  linkSelection(note.id, selLink.text);
                  setSelLink(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                ＋ [[ 双链 ]]
              </button>
            )}
          </div>
        )}
      </section>

      {editMode !== "source" && <RightRail note={note} containerRef={containerRef} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={areaMenuItems()} onClose={() => setCtx(null)} />}
    </div>
  );
}

/** "今天" 视图：定位或创建当日笔记并进入编辑器 */
export function DailyView() {
  const ensureDaily = useStore((s) => s.ensureDaily);
  const notes = useStore((s) => s.notes);
  const activeId = useStore((s) => s.activeId);

  const daily = notes.find((n) => n.date === TODAY && !n.vaultRoot);
  useEffect(() => {
    if (daily && activeId !== daily.id) useStore.setState({ activeId: daily.id });
  }, [daily, activeId]);

  // 不自动落盘：当日笔记不存在时只给空态，点按钮才创建
  if (!daily) {
    return (
      <div className="grid flex-1 place-items-center bg-background">
        <div className="text-center">
          <div className="font-serif text-[44px] opacity-25">P</div>
          <p className="mt-2.5 text-[13px] text-muted-foreground">今天还没有笔记</p>
          <button
            className="mt-5 rounded-lg bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
            onClick={() => {
              const id = ensureDaily();
              if (id) useStore.setState({ activeId: id });
            }}
          >
            新建今日笔记
          </button>
        </div>
      </div>
    );
  }
  return <Editor noteId={daily.id} key={daily.id} />;
}
