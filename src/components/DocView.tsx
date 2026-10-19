import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ExternalLink, FolderSearch, Trash2 } from "lucide-react";
import { useStore, getVault, revealNoteInExplorer } from "@/store";
import { isTauri } from "@/lib/vault";
import { clampSheetRange, renderableInApp, SHEET_VIEW_MAX_COLS, SHEET_VIEW_MAX_ROWS, type WorkSheetLike } from "@/lib/office";
import { cn } from "@/lib/utils";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type DocState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "pdf"; dataUrl: string }
  | { phase: "docx"; bytes: Uint8Array }
  | { phase: "xlsx"; sheets: { name: string; html: string; truncated: boolean }[] }
  | { phase: "fallback" }; // 旧格式：系统打开

/** 办公文档查看器：pdf 内嵌、docx/xlsx 应用内渲染，旧格式走系统默认程序 */
export default function DocView({ noteId }: { noteId: string }) {
  const notes = useStore((s) => s.notes);
  const note = notes.find((n) => n.id === noteId);
  const deleteNote = useStore((s) => s.deleteNote);
  const [state, setState] = useState<DocState>({ phase: "loading" });
  const [sheet, setSheet] = useState(0);
  const docxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setSheet(0);
    if (!note?.rel || !isTauri()) {
      setState({ phase: "error", message: isTauri() ? "文件不可读" : "内存仓库不含办公文档，桌面模式打开仓库后可用" });
      return;
    }
    const root = note.vaultRoot ?? null;
    void (async () => {
      try {
        setState({ phase: "loading" });
        const primary = await invoke<string | null>("initial_vault").catch(() => null);
        const useRoot = root ?? localStorage.getItem("pkmx.vault.root") ?? primary;
        if (!useRoot) throw new Error("未找到文件所属仓库");
        const b64 = await invoke<string>("vault_read_bin", { root: useRoot, rel: note.rel });
        if (!alive) return;
        if (b64.length * 0.75 > 128 * 1024 * 1024) {
          throw new Error("文件超过 128MB，应用内预览已跳过，请用系统程序打开");
        }
        const bytes = b64ToBytes(b64);
        const ext = note.ext ?? "";
        if (ext === "pdf") {
          setState({ phase: "pdf", dataUrl: `data:application/pdf;base64,${b64}` });
        } else if (ext === "docx") {
          setState({ phase: "docx", bytes });
        } else if (ext === "xlsx" || ext === "xls") {
          // xls（BIFF 二进制）与 xlsx 走同一条 SheetJS 管线：read 自动识别格式
          const XLSX = await import("xlsx");
          const wb = XLSX.read(bytes, { type: "array" });
          const sheets = wb.SheetNames.map((name) => {
            const ws = wb.Sheets[name] as WorkSheetLike;
            try {
              // 幻影范围（如整列格式化产生的 A1:XFD1048576）会让 sheet_to_html 爆内存，先收敛到实际数据范围
              const { truncated } = clampSheetRange(XLSX.utils, ws);
              return { name, html: XLSX.utils.sheet_to_html(wb.Sheets[name], { id: name }), truncated };
            } catch {
              return { name, html: "", truncated: false }; // 单个工作表失败不影响其他页
            }
          });
          if (!alive) return;
          setState({ phase: "xlsx", sheets });
        } else {
          setState({ phase: "fallback" });
        }
      } catch (e) {
        if (alive) setState({ phase: "error", message: String(e) });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, note?.rel]);

  // docx 渲染到容器
  useEffect(() => {
    if (state.phase !== "docx" || !docxRef.current) return;
    const host = docxRef.current;
    host.innerHTML = "";
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        await renderAsync(new Blob([state.bytes as BlobPart]), host, undefined, { inWrapper: true });
      } catch (e) {
        host.innerHTML = `<p style="color:var(--muted-foreground);font-size:13px">Word 渲染失败：${String(e)}</p>`;
      }
    })();
  }, [state]);

  if (!note) return <div className="flex-1 bg-background" />;

  const openWithSystem = async () => {
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      const root = note.vaultRoot ?? localStorage.getItem("pkmx.vault.root");
      if (!root || !note.rel) throw new Error("未找到文件路径");
      await openPath(`${root}/${note.rel}`.replace(/\\/g, "/"));
    } catch (e) {
      toast.error("系统打开失败", { description: String(e) });
    }
  };

  const doDelete = () => {
    void useStore.getState()
      .openConfirm("删除文件", `将删除本地文件「${note.fileName}」，该操作不可恢复。`, { okLabel: "删除", danger: true })
      .then((ok) => ok && deleteNote(note.id));
  };

  const ext = note.ext ?? "";

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* 顶栏 */}
      <div className="flex items-center gap-1.5 border-b border-border/70 px-3.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">{note.vaultName ?? getVault().rootName}</span>
          {note.folder && (
            <>
              <span className="opacity-50">/</span>
              <span className="max-w-[200px] truncate">{note.folder}</span>
            </>
          )}
          <span className="opacity-50">/</span>
          <span className="truncate font-mono text-[11px] text-secondary-foreground">{note.fileName}</span>
        </div>
        <div className="ml-auto flex shrink-0 gap-0.5">
          <button
            className="flex items-center gap-1.5 rounded-md px-2 py-[5px] text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void openWithSystem()}
            title="用系统默认程序打开"
          >
            <ExternalLink size={12} strokeWidth={1.5} />
            系统打开
          </button>
          <button
            className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => void revealNoteInExplorer(note)}
            title="在资源管理器中显示"
          >
            <FolderSearch size={13} strokeWidth={1.5} />
          </button>
          <button
            className="grid size-[26px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-st-blocked"
            onClick={doDelete}
            title="删除文件"
          >
            <Trash2 size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* 内容区 */}
      {state.phase === "loading" && (
        <div className="grid flex-1 place-items-center text-[13px] text-muted-foreground">读取中…</div>
      )}
      {state.phase === "error" && (
        <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-muted-foreground">
          <div>
            {state.message}
            <div className="mt-3">
              <button className="rounded-full border border-dashed border-border px-4 py-1.5 text-xs transition-colors hover:border-primary hover:text-primary" onClick={() => void openWithSystem()}>
                尝试用系统程序打开
              </button>
            </div>
          </div>
        </div>
      )}
      {(state.phase === "fallback" || !renderableInApp(ext) && state.phase !== "loading" && state.phase !== "error") && (
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-[2px] text-muted-foreground">{ext}</div>
            <p className="mt-2 text-[13px] text-muted-foreground">
              {note.fileName}
              <br />
              此格式暂不支持应用内预览
            </p>
            <button
              className="mt-4 flex items-center gap-1.5 rounded-full border border-dashed border-border px-4 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={() => void openWithSystem()}
            >
              <ExternalLink size={12} /> 用系统默认程序打开
            </button>
          </div>
        </div>
      )}
      {state.phase === "pdf" && (
        <div className="min-h-0 flex-1">
          <iframe src={state.dataUrl} title={note.fileName} className="h-full w-full border-none" />
        </div>
      )}
      {state.phase === "docx" && (
        <div className="min-h-0 flex-1 overflow-auto bg-secondary/40 px-4 py-6">
          <div ref={docxRef} className="mx-auto max-w-[900px] bg-background shadow-md [&_.docx-wrapper]:bg-background [&_.docx]:mb-4 [&_.docx]:bg-white" />
        </div>
      )}
      {state.phase === "xlsx" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {state.sheets.length > 1 && (
            <div className="flex gap-1 overflow-x-auto border-b border-border/70 px-3 py-1.5">
              {state.sheets.map((s, i) => (
                <button
                  key={s.name}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    i === sheet && "bg-accent text-foreground",
                  )}
                  onClick={() => setSheet(i)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          )}
          {state.sheets[sheet]?.truncated && (
            <p className="shrink-0 border-b border-border/70 px-6 py-1.5 text-center text-xs text-muted-foreground">
              表格超出预览上限（{SHEET_VIEW_MAX_ROWS.toLocaleString()} 行 / {SHEET_VIEW_MAX_COLS.toLocaleString()} 列），已截断显示，完整内容请用系统程序打开
            </p>
          )}
          {/* 表格保持自然宽度，超出内容区由这里横向滚动；overflow-hidden 的父链路确保只影响内容区 */}
          <div
            className="min-h-0 min-w-0 flex-1 overflow-auto px-6 py-4 [&_table]:border-collapse [&_table]:text-nowrap [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-[12.5px] [&_th]:border [&_th]:border-border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-[12px] [&_th]:font-medium"
            dangerouslySetInnerHTML={{ __html: state.sheets[sheet]?.html ?? "" }}
          />
        </div>
      )}
    </div>
  );
}
