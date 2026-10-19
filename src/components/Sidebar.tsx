import { Plus, PlusCircle, Trash2, Waypoints } from "lucide-react";
import {
  AlarmClock,
  Calendar,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore, type ViewKind } from "@/store";
import { isTauri } from "@/lib/vault";
import { lastNDays } from "@/lib/dates";
import { open } from "@tauri-apps/plugin-dialog";
import FileTree from "./FileTree";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function SecHeader({ label, action }: { label: string; action?: React.ReactNode }) {
  return (
    <div className="mt-2.5 mb-1 flex items-center justify-between px-1.5">
      <span className="font-mono text-[10.5px] tracking-[2px] text-muted-foreground">{label}</span>
      {action}
    </div>
  );
}

export default function Sidebar() {
  const notes = useStore((s) => s.notes);
  const views = useStore((s) => s.views);
  const view = useStore((s) => s.view);
  const viewId = useStore((s) => s.viewId);
  const setView = useStore((s) => s.setView);
  const setCaptureOpen = useStore((s) => s.setCaptureOpen);
  const openPrompt = useStore((s) => s.openPrompt);
  const createNoteIn = useStore((s) => s.createNoteIn);
  const deleteView = useStore((s) => s.deleteView);

  const openTasks = notes.filter((n) => n.status && ["Todo", "Doing", "Blocked"].includes(n.status)).length;
  const doneCnt = notes.filter((n) => n.done && lastNDays(7).includes(n.done)).length;

  const items: { kind: ViewKind; icon: React.ReactNode; label: string; cnt?: number; hot?: boolean }[] = [
    { kind: "daily", icon: <Calendar size={14} strokeWidth={1.4} />, label: "今天" },
    { kind: "due", icon: <AlarmClock size={14} strokeWidth={1.4} />, label: "未完成", cnt: openTasks },
    { kind: "week", icon: <TrendingUp size={14} strokeWidth={1.4} />, label: "已完成", cnt: doneCnt },
    { kind: "graph", icon: <Waypoints size={14} strokeWidth={1.4} />, label: "图谱" },
  ];

  const newNote = async (folder = "") => {
    const v = await openPrompt(folder ? `在 ${folder}/ 新建笔记` : "新建笔记", {
      label: folder ? undefined : "标题里可用 开发/xxx 的形式直接指定文件夹",
      placeholder: "笔记标题…",
    });
    if (v?.trim()) {
      let f = folder;
      let title = v.trim();
      const slash = title.lastIndexOf("/");
      if (!folder && slash > 0) {
        f = title.slice(0, slash).trim();
        title = title.slice(slash + 1).trim();
      }
      if (title) createNoteIn(title, f);
    }
  };

  const newFolder = async () => {
    const v = await openPrompt("新建文件夹", {
      label: "文件系统里空文件夹不会保留，将自动创建一篇同名索引笔记",
      placeholder: "文件夹名…",
    });
    if (v?.trim()) createNoteIn(v.trim(), v.trim());
  };

  const openFiles = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "Markdown", extensions: ["md"] }] });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (list.length) void useStore.getState().openPaths(list);
  };

  const openFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") void useStore.getState().openPaths([dir]);
  };

  return (
    <nav className="flex w-[248px] shrink-0 flex-col overflow-y-auto border-r border-border bg-sidebar px-2 pb-2">
      <SecHeader label="视图" />
      {items.map((it) => (
        <button
          key={it.kind}
          onClick={() => setView(it.kind, null)}
          className={cn(
            "relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[14px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            view === it.kind && "bg-accent font-medium text-foreground",
            view === it.kind &&
              "before:absolute before:-left-2 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-primary",
          )}
        >
          <span className="grid size-[15px] place-items-center text-muted-foreground">{it.icon}</span>
          {it.label}
          {!!it.cnt && (
            <span
              className={cn(
                "ml-auto font-mono text-[10.5px] text-muted-foreground",
                it.hot && "font-semibold text-st-blocked",
              )}
            >
              {it.cnt}
            </span>
          )}
        </button>
      ))}

      {views.length > 0 && (
        <>
          {views.map((v) => (
            <div
              key={v.id}
              className={cn(
                "group relative flex w-full items-center rounded-md transition-colors hover:bg-accent",
                view === "saved" && viewId === v.id && "bg-accent",
              )}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left text-[14px] text-muted-foreground group-hover:text-foreground"
                onClick={() => setView("saved", null, v.id)}
                title={v.id}
              >
                <span className="grid size-[15px] place-items-center text-muted-foreground">
                  <PlusCircle size={12} strokeWidth={1.3} className="opacity-0" />
                  <span className="absolute size-1.5 rounded-full bg-primary/70" />
                </span>
                <span className="min-w-0 flex-1 truncate">{v.name}</span>
              </button>
              <button
                className="mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-st-blocked"
                onClick={() => deleteView(v.id)}
                title="删除视图"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </>
      )}
      <div className="mx-1.5 mt-3 border-t border-border/70" />

      <SecHeader
        label="笔记"
        action={
          <DropdownMenu>
            <DropdownMenuTrigger className="grid size-[19px] place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-primary" title="新建">
              <Plus size={13} strokeWidth={1.8} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => void newNote("")}>新建笔记…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void newFolder()}>新建文件夹…</DropdownMenuItem>
              {isTauri() && (
                <>
                  <DropdownMenuItem onClick={() => void openFiles()}>打开文件…</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void openFolder()}>打开文件夹…</DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => setCaptureOpen(true)}>快速捕获…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <FileTree onNewInFolder={(f) => void newNote(f)} />
    </nav>
  );
}
