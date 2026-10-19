import { useStore, getVault } from "@/store";
import { cn } from "@/lib/utils";

const VIEW_LABEL: Record<string, string> = {
  note: "笔记",
  board: "Issue 看板",
  archive: "已归档",
  report: "工作报告",
  search: "搜索",
  issue: "Issue",
  saved: "保存视图",
  settings: "设置",
};

export default function Statusbar() {
  const view = useStore((s) => s.view);
  const needsVault = useStore((s) => s.needsVault);
  const notes = useStore((s) => s.notes);
  const issues = useStore((s) => s.issues);
  const open = issues.filter((i) => i.status !== "Done").length;

  return (
    <footer className="flex h-[27px] items-center gap-4 border-t border-border bg-secondary px-3.5 font-mono text-[10.5px] text-muted-foreground select-none">
      <span>{VIEW_LABEL[view] ?? view}</span>
      <span>
        {notes.length} 篇笔记 · {open} 个未关闭 Issue
      </span>
      <div className="ml-auto flex gap-3.5">
        <span className="hidden [@media(min-width:1080px)]:inline">
          Ctrl+P 快速打开 · Ctrl+N 捕获 · Ctrl+\ 源码
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn("size-[6px] rounded-full", needsVault ? "bg-muted-foreground/50" : "bg-st-done")} />
          {needsVault
            ? "尚未选择文档目录"
            : getVault().kind === "fs"
              ? "本地文件仓库"
              : "内存仓库（不落盘）"}
        </span>
      </div>
    </footer>
  );
}
