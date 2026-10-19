import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { useStore } from "@/store";
import { isTauri } from "@/lib/vault";
import Titlebar from "@/components/Titlebar";
import Sidebar from "@/components/Sidebar";
import Editor, { DailyView } from "@/components/Editor";
import { OpenView, DoneView, SavedViewRunner } from "@/components/Views";
import CaptureDialog from "@/components/CaptureDialog";
import QuickOpen from "@/components/QuickOpen";
import Statusbar from "@/components/Statusbar";
import VaultGate from "@/components/VaultGate";
import SearchView from "@/components/SearchView";
import GraphView from "@/components/GraphView";
import PromptDialog from "@/components/PromptDialog";
import ConfirmDialog from "@/components/ConfirmDialog";
import SettingsView from "@/components/SettingsView";
import ContextMenu from "@/components/ContextMenu";
import DocView from "@/components/DocView";

function EmptyState() {
  const setCaptureOpen = useStore((s) => s.setCaptureOpen);
  return (
    <div className="grid flex-1 place-items-center bg-background text-muted-foreground" data-ctx-area>
      <div className="text-center">
        <div className="font-serif text-[44px] opacity-25">P</div>
        <p className="mt-2.5 text-[13px]">
          从左侧文件树选择一篇笔记，或{" "}
          <button
            className="text-primary underline underline-offset-2"
            onClick={() => setCaptureOpen(true)}
          >
            快速捕获
          </button>
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const needsVault = useStore((s) => s.needsVault);
  const view = useStore((s) => s.view);
  const viewId = useStore((s) => s.viewId);
  const activeId = useStore((s) => s.activeId);
  /** 当前打开的是办公文档 → DocView 而非 Markdown 编辑器 */
  const activeDoc = useStore((s) => Boolean(s.activeId && s.notes.find((n) => n.id === s.activeId)?.doc));
  const init = useStore((s) => s.init);
  /** 文件拖入指示 */
  const [dragOver, setDragOver] = useState(false);
  /** 应用默认右键菜单（具体组件的菜单会 stopPropagation 接管） */
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // 桌面：原生拖放事件提供绝对路径，交给 Rust 拷贝导入
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      void getCurrentWindow().onDragDropEvent((ev) => {
        const p = ev.payload as { type: string; paths?: string[] };
        if (p.type === "drop") {
          setDragOver(false);
          if (p.paths?.length) void useStore.getState().openPaths(p.paths);
        } else if ((p.type === "enter" || p.type === "over") && p.paths?.length) {
          setDragOver(true);
        } else if (p.type === "leave") {
          setDragOver(false);
        }
      }).then((fn) => {
        un = fn;
      });
    });
    return () => un?.();
  }, []);

  // 浏览器/内存仓库：HTML5 拖放读文本直接入库（目录经 webkitGetAsEntry 递归）
  const onDocDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (isTauri()) return; // 桌面走上面的原生事件
    const entries: { path: string; text: string }[] = [];
    const walkEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) =>
          (entry as FileSystemFileEntry).file(res, rej),
        );
        if (!file.name.toLowerCase().endsWith(".md")) return;
        entries.push({ path: `${prefix}${file.name}`, text: await file.text() });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const readBatch = () => new Promise<FileSystemEntry[]>((res) => reader.readEntries(res));
        let batch = await readBatch();
        while (batch.length) {
          for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`);
          batch = await readBatch();
        }
      }
    };
    const items = [...e.dataTransfer.items]
      .filter((i) => i.kind === "file")
      .map((i) => i.webkitGetAsEntry())
      .filter((x): x is FileSystemEntry => Boolean(x));
    if (items.length) {
      for (const entry of items) await walkEntry(entry, "");
    } else {
      for (const f of [...e.dataTransfer.files]) {
        if (f.name.toLowerCase().endsWith(".md")) entries.push({ path: f.name, text: await f.text() });
      }
    }
    if (entries.length) useStore.getState().importTexts(entries);
  };

  // 全局右键：输入处保留原生菜单；其余一律屏蔽 webview 原生菜单，
  // 但只有文件树与正文空白处（data-ctx-area）才弹应用菜单——视图页面/侧栏视图项不弹
  const onRootContextMenu = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, [contenteditable='true']")) return;
    e.preventDefault();
    if (!el.closest("[data-ctx-area]")) return;
    setCtx({ x: e.clientX, y: e.clientY });
  };

  // 外部超链接拦截：交给系统默认浏览器打开，杜绝 webview 自行导航报错。
  // 挂在 document 上统一接管所有渲染内容（笔记正文 / docx / 表格）里的链接。
  useEffect(() => {
    const onLink = (e: MouseEvent) => {
      const a = (e.target as HTMLElement)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      const href = a.getAttribute("href") ?? "";
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return; // 站内锚点放行
      e.preventDefault();
      if (isTauri()) {
        void import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(href))
          .catch(() => undefined);
      } else {
        window.open(href, "_blank", "noopener");
      }
    };
    document.addEventListener("click", onLink);
    return () => document.removeEventListener("click", onLink);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "n") {
        e.preventDefault();
        useStore.getState().setCaptureOpen(true);
      } else if (k === "p") {
        e.preventDefault();
        useStore.getState().setQuickOpenOpen(true);
      } else if (e.key === "\\") {
        e.preventDefault();
        useStore.getState().cycleEditMode(); // 阅读 → 块编辑 → 源码
      } else if (k === "f") {
        e.preventDefault();
        useStore.getState().setView("search");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) {
    return (
      <div className="grid h-screen place-items-center bg-background">
        <span className="font-serif text-2xl text-muted-foreground/40">PKMX</span>
      </div>
    );
  }

  return (
    <div
      className="grid h-screen grid-rows-[44px_minmax(0,1fr)_27px] overflow-hidden"
      onContextMenu={onRootContextMenu}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => void onDocDrop(e)}
    >
      <Titlebar />
      {/* min-w-0 必须有：grid 子项默认 min-width:auto，超宽内容（如 xlsx 表格）会把整个布局顶开 */}
      <div className="flex min-h-0 min-w-0">
        {/* 未选择仓库时隐藏侧栏，让欢迎引导独占内容区（设置仍可从顶栏打开） */}
        {!needsVault && <Sidebar />}
        <main className="flex min-w-0 flex-1">
          {/* 设置不依赖仓库；其余界面在未选仓库时统一显示欢迎引导 */}
          {view === "settings" ? (
            <SettingsView />
          ) : needsVault ? (
            <VaultGate />
          ) : view === "daily" ? (
            <DailyView />
          ) : view === "due" ? (
            <OpenView />
          ) : view === "week" ? (
            <DoneView />
          ) : view === "search" ? (
            <SearchView />
          ) : view === "graph" ? (
            <GraphView />
          ) : view === "saved" ? (
            <SavedViewRunner viewId={viewId} />
          ) : activeId ? (
            activeDoc ? (
              <DocView noteId={activeId} />
            ) : (
              <Editor noteId={activeId} />
            )
          ) : (
            <EmptyState />
          )}
        </main>
      </div>
      <Statusbar />
      {dragOver && !needsVault && (
        <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-background/75">
          <div className="rounded-2xl border-2 border-dashed border-primary px-10 py-8 text-center">
            <div className="font-serif text-2xl font-bold">松开，打开</div>
            <div className="mt-1.5 font-mono text-[11px] text-muted-foreground">
              文件夹作为仓库加入 · .md 原地读写（不复制）
            </div>
          </div>
        </div>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: "新建笔记…",
              onClick: () => void useStore.getState().openPrompt("新建笔记", { placeholder: "笔记标题…" }).then((v) => {
                if (v?.trim()) useStore.getState().createNoteIn(v.trim(), "");
              }),
            },
            { label: "快速捕获…", onClick: () => useStore.getState().setCaptureOpen(true) },
            { sep: true },
            { label: "设置", onClick: () => useStore.setState({ view: "settings" }) },
          ]}
        />
      )}
      <CaptureDialog />
      <QuickOpen />
      <PromptDialog />
      <ConfirmDialog />
      <Toaster position="bottom-right" offset={36} />
    </div>
  );
}
