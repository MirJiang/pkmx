import { useState } from "react";
import { FilePlus, FolderTree, Minus, Moon, Plus, Search, Settings, Square, Sun, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "@/store";
import { isTauri } from "@/lib/vault";
import { themeKind } from "@/lib/themes";
import VaultDialog from "./VaultDialog";

/** 顶栏文字按钮统一样式 */
const TB_BTN =
  "flex items-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-card px-[5px] py-px font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  );
}

/** 无边框窗口的自定义标题栏：拖拽区 + 最小化/最大化/关闭 */
function WindowControls() {
  const w = () => getCurrentWindow();
  return (
    <div className="ml-1 flex">
      <button
        className="grid h-8 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => void w().minimize()}
        title="最小化"
        aria-label="最小化"
      >
        <Minus size={13} strokeWidth={1.6} />
      </button>
      <button
        className="grid h-8 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => void w().toggleMaximize()}
        title="最大化 / 还原"
        aria-label="最大化 / 还原"
      >
        <Square size={11} strokeWidth={1.6} />
      </button>
      <button
        className="grid h-8 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-[#c0392b] hover:text-white"
        onClick={() => void w().close()}
        title="关闭"
        aria-label="关闭"
      >
        <X size={14} strokeWidth={1.6} />
      </button>
    </div>
  );
}

export default function Titlebar() {
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const setCaptureOpen = useStore((s) => s.setCaptureOpen);
  const createNoteIn = useStore((s) => s.createNoteIn);
  const openPrompt = useStore((s) => s.openPrompt);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const dark = useStore((s) => themeKind(s.theme) === "dark");
  const [vaultOpen, setVaultOpen] = useState(false);

  /** 新建笔记：标题里带 / 可指定文件夹，落点遵循「设置 → 通用 → 默认文档地址」 */
  const newNote = async () => {
    const v = await openPrompt("新建笔记", {
      label: "标题里可用 开发/xxx 的形式直接指定文件夹",
      placeholder: "笔记标题…",
    });
    if (!v?.trim()) return;
    let folder = "";
    let title = v.trim();
    const slash = title.lastIndexOf("/");
    if (slash > 0) {
      folder = title.slice(0, slash).trim();
      title = title.slice(slash + 1).trim();
    }
    if (title) createNoteIn(title, folder);
  };

  return (
    <header
      /* Tauri 注入脚本识别 data-tauri-drag-region："deep" 让整个子树可拖拽，
         按钮/输入框等可点击元素自动豁免；双击最大化也由该脚本处理（internal_toggle_maximize），
         勿再叠加 React 双击处理器，否则会双触发互相抵消 */
      data-tauri-drag-region="deep"
      className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-secondary px-3 pl-3.5 select-none"
    >
      <div className="flex items-center gap-1">
        <button className={TB_BTN} onClick={() => setVaultOpen(true)} title="仓库管理">
          <FolderTree size={13} strokeWidth={1.6} />
          仓库管理
        </button>
        <button className={TB_BTN} onClick={() => void newNote()} title="新建笔记">
          <FilePlus size={13} strokeWidth={1.6} />
          新建笔记
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button className={TB_BTN} onClick={() => setQuickOpenOpen(true)}>
          <Search size={13} strokeWidth={1.5} />
          搜索 <Kbd>Ctrl P</Kbd>
        </button>
        <button className={TB_BTN} onClick={() => setCaptureOpen(true)}>
          <Plus size={13} strokeWidth={1.6} />
          捕获 <Kbd>Ctrl N</Kbd>
        </button>
        <button
          className="grid size-[30px] place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={toggleTheme}
          title="切换 夜墨/昼白 主题"
          aria-label="切换主题"
        >
          {dark ? <Sun size={15} strokeWidth={1.4} /> : <Moon size={15} strokeWidth={1.4} />}
        </button>
        <button
          className={`grid size-[30px] place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
            view === "settings" ? "bg-accent text-foreground" : ""
          }`}
          onClick={() => setView(view === "settings" ? "note" : "settings", null)}
          title="设置"
          aria-label="设置"
        >
          <Settings size={15} strokeWidth={1.4} />
        </button>
        {isTauri() && <WindowControls />}
      </div>

      <VaultDialog open={vaultOpen} onOpenChange={setVaultOpen} />
    </header>
  );
}
