import { useState } from "react";
import { ChevronRight, FileSpreadsheet, FileText, Folder, Presentation, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore, revealNoteInExplorer, isExternalNote, extraVaultRootOf } from "@/store";
import { isTauri } from "@/lib/vault";
import { StatusDot } from "./Chips";
import ContextMenu, { type CtxItem } from "./ContextMenu";

const docIcon = (ext?: string, size = 13) => {
  if (ext === "xlsx" || ext === "xls") return <FileSpreadsheet size={size} className="shrink-0" strokeWidth={1.3} />;
  if (ext === "pptx" || ext === "ppt") return <Presentation size={size} className="shrink-0" strokeWidth={1.3} />;
  return <FileText size={size} className="shrink-0" strokeWidth={1.3} />;
};

export default function FileTree({ onNewInFolder }: { onNewInFolder?: (folder: string) => void }) {
  const notes = useStore((s) => s.notes);
  const activeId = useStore((s) => s.activeId);
  const openFolders = useStore((s) => s.openFolders);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const openNote = useStore((s) => s.openNote);
  const [ctx, setCtx] = useState<{ x: number; y: number; noteId?: string; folder?: string } | null>(null);

  const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort();
  const zhSort = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, "zh");

  const noteMenuItems = (noteId: string): CtxItem[] => {
    const note = notes.find((n) => n.id === noteId);
    if (!note) return [];
    const s = useStore.getState();
    const doDelete = () => {
      void s.openConfirm("删除文件", `将删除本地文件「${note.fileName}」，该操作不可恢复。`, {
        okLabel: "删除",
        danger: true,
      }).then((ok) => ok && s.deleteNote(noteId));
    };
    if (note.doc) {
      const items: CtxItem[] = [{ label: "打开", onClick: () => s.openNote(noteId) }];
      if (isTauri()) {
        items.push({ sep: true }, { label: "在资源管理器中显示", onClick: () => void revealNoteInExplorer(note) });
      }
      items.push({ sep: true }, { label: "删除", danger: true, onClick: doDelete });
      return items;
    }
    const doRename = async () => {
      const v = await s.openPrompt("重命名文件", {
        label: `当前：${note.fileName}（仅改文件名，不改标题）`,
        value: note.fileName.replace(/\.md$/i, ""),
        placeholder: "新文件名（不含 .md）",
      });
      if (v?.trim()) s.renameNote(noteId, v.trim());
    };
    const items: CtxItem[] = [
      { label: "打开", onClick: () => s.openNote(noteId) },
      { label: "重命名…", onClick: () => void doRename() },
    ];
    const targets = folders.filter((f) => f !== note.folder).slice(0, 8);
    if (targets.length || note.folder) {
      items.push({ sep: true, label: "移动到" });
      if (note.folder) items.push({ label: "· 根目录", onClick: () => s.moveNote(noteId, "") });
      for (const f of targets) items.push({ label: `· ${f}/`, onClick: () => s.moveNote(noteId, f) });
    }
    items.push({ sep: true }, { label: "删除", danger: true, onClick: doDelete });
    if (isExternalNote(note)) {
      // 外部打开的单文件不在仓库里，删除无从谈起：只能从列表注销跟踪
      items.push({ label: "从列表移除", onClick: () => s.forgetExternalFile(noteId) });
    }
    if (isTauri()) {
      items.push({ sep: true }, { label: "在资源管理器中显示", onClick: () => void revealNoteInExplorer(note) });
    }
    return items;
  };

  const folderMenuItems = (folder: string): CtxItem[] => {
    const s = useStore.getState();
    const root = extraVaultRootOf(folder);
    // 同时加载的仓库的顶层节点 = 另一个仓库根目录：只能卸载或打开，不能在树里改名/删除
    if (root) {
      const items: CtxItem[] = [{ label: "卸载此仓库", danger: true, onClick: () => s.unloadVault(root) }];
      if (isTauri()) {
        items.push({ sep: true }, { label: "在资源管理器中打开", onClick: () => void s.revealFolder(folder) });
      }
      return items;
    }
    const doRename = async () => {
      const segs = folder.split("/");
      const v = await s.openPrompt("重命名文件夹", {
        label: `当前：${segs[segs.length - 1]}（目录整体改名，里面的文件一并跟随）`,
        value: segs[segs.length - 1],
        placeholder: "新文件夹名",
      });
      if (v?.trim()) void s.renameFolder(folder, v.trim());
    };
    const doNewSub = async () => {
      const v = await s.openPrompt("新建子文件夹", {
        label: "文件夹里空目录不会保留，将自动创建一篇同名占位笔记",
        placeholder: "子文件夹名…",
      });
      if (v?.trim()) s.createSubFolder(folder, v.trim());
    };
    const doDelete = () => {
      void s
        .openConfirm(
          "删除文件夹",
          `将删除磁盘上的「${folder}」整个目录（含子目录与其中全部文件，办公文档、附件一并删除），该操作不可恢复。`,
          { okLabel: "删除", danger: true },
        )
        .then((ok) => ok && void s.deleteFolder(folder));
    };
    const items: CtxItem[] = [];
    if (onNewInFolder) items.push({ label: "在此新建笔记…", onClick: () => onNewInFolder(folder) });
    items.push(
      { label: "新建子文件夹…", onClick: () => void doNewSub() },
      { sep: true },
      { label: "重命名…", onClick: () => void doRename() },
    );
    if (isTauri()) items.push({ label: "在资源管理器中打开", onClick: () => void s.revealFolder(folder) });
    items.push({ sep: true }, { label: "删除文件夹", danger: true, onClick: doDelete });
    return items;
  };

  /** 把 folder 路径字符串组装成真正的层级树（嵌套目录逐级展示，不再平铺） */
  interface TreeNode {
    name: string; // 显示名（路径最后一段）
    path: string; // 完整路径（toggle / 右键 / 新建都用它）
    folders: Map<string, TreeNode>;
    files: (typeof notes)[number][];
  }
  const tree: TreeNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const n of notes) {
    const segs = (n.folder ?? "").split("/").filter(Boolean);
    let cur = tree;
    for (const s of segs) {
      let next = cur.folders.get(s);
      if (!next) {
        next = { name: s, path: cur.path ? `${cur.path}/${s}` : s, folders: new Map(), files: [] };
        cur.folders.set(s, next);
      }
      cur = next;
    }
    cur.files.push(n);
  }
  const zhByName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, "zh");

  const fileRow = (n: (typeof notes)[number], depth: number) => (
    <button
      key={n.id}
      onClick={() => openNote(n.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation(); // 不触发 App 级默认菜单
        setCtx({ x: e.clientX, y: e.clientY, noteId: n.id });
      }}
      style={{ marginLeft: depth * 15 }}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-[14px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        activeId === n.id && "bg-accent font-medium text-foreground",
      )}
    >
      {docIcon(n.ext)}
      <span className="min-w-0 flex-1 truncate">{n.title}</span>
      {n.doc && (
        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground/80">.{n.ext}</span>
      )}
      {n.status && !n.doc && !["Done", "Wont"].includes(n.status) && <StatusDot s={n.status as never} />}
    </button>
  );

  const renderFolder = (node: TreeNode, depth: number): React.ReactNode => {
    const open = openFolders[node.path] ?? false; // 默认全部折叠
    const zhKids = [...node.files].sort(zhSort);
    return (
      <div key={node.path}>
        <button
          onClick={() => toggleFolder(node.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation(); // 不触发 App 级默认菜单
            setCtx({ x: e.clientX, y: e.clientY, folder: node.path });
          }}
          style={{ marginLeft: depth * 15 }}
          className="group flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-left text-[14px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span
            className={cn(
              "grid size-3 shrink-0 place-items-center text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          >
            <ChevronRight size={10} strokeWidth={1.8} />
          </span>
          <Folder size={13} className="shrink-0" strokeWidth={1.3} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {onNewInFolder && (
            <span
              className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
              title="在此文件夹新建笔记"
              onClick={(e) => {
                e.stopPropagation();
                onNewInFolder(node.path);
              }}
            >
              <Plus size={11} strokeWidth={1.8} />
            </span>
          )}
          <span className="ml-1 font-mono text-[10px] text-muted-foreground/70 group-hover:opacity-0">{node.files.length}</span>
        </button>
        {open && (
          <>
            {[...node.folders.values()].sort(zhByName).map((f) => renderFolder(f, depth + 1))}
            {zhKids.map((n) => fileRow(n, depth + 1))}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-1 flex-col gap-px" data-ctx-area>
      {[...tree.folders.values()].sort(zhByName).map((f) => renderFolder(f, 0))}
      {[...tree.files]
        .sort(zhSort)
        .map((n) => fileRow(n, 0))}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={ctx.noteId ? noteMenuItems(ctx.noteId) : ctx.folder ? folderMenuItems(ctx.folder) : []}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
