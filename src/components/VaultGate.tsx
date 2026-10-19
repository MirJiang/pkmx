import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FileText, FolderOpen, Link2, ListChecks } from "lucide-react";
import { useStore } from "@/store";
import { isTauri } from "@/lib/vault";

const POINTS = [
  {
    icon: FileText,
    title: "纯本地 Markdown",
    desc: "笔记就是 .md 文件，随时可以用其他编辑器打开。",
  },
  {
    icon: Link2,
    title: "双向链接",
    desc: "用 [[笔记名]] 串联想法，在图谱里看见它们的关系。",
  },
  {
    icon: ListChecks,
    title: "任务与视图",
    desc: "给笔记加上 status 就是任务，自动汇总到未完成列表。",
  },
];

/** 首次启动 / 尚未选择仓库时的欢迎引导：选择文档目录后直接作为仓库打开 */
export default function VaultGate() {
  const openFolderVault = useStore((s) => s.openFolderVault);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const dir = await open({ directory: true, title: "选择文档目录" });
    if (typeof dir !== "string") return;
    setBusy(true);
    try {
      await openFolderVault(dir);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 overflow-y-auto bg-background">
      <div className="mx-auto flex w-full max-w-[640px] flex-col justify-center px-8 py-14">
        <div className="text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-border/80 bg-card shadow-sm">
            <span className="font-serif text-[26px] font-bold text-primary">P</span>
          </div>
          <h1 className="mt-5 font-serif text-[28px] font-bold tracking-tight">欢迎使用 PKMX</h1>
          <p className="mx-auto mt-2.5 max-w-[440px] text-[13.5px] leading-relaxed text-muted-foreground">
            本地优先的 Markdown 笔记与任务。先选择一个文件夹作为你的文档目录，
            所有内容都会保存在里面，不会上传到任何地方。
          </p>
        </div>

        <div className="mt-8 rounded-2xl border border-border/70 bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[14px] font-medium">
                <FolderOpen size={15} strokeWidth={1.5} className="text-primary" />
                选择文档目录
              </div>
              <p className="mt-1.5 max-w-[360px] text-[12.5px] leading-relaxed text-muted-foreground">
                新笔记与快速捕获默认保存在这个目录的根级；之后可在
                「设置 → 通用 → 默认文档地址」中指定子目录。
              </p>
            </div>
            <button
              className="flex shrink-0 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              onClick={() => void pick()}
              disabled={!isTauri() || busy}
            >
              <FolderOpen size={14} strokeWidth={1.6} />
              {busy ? "正在打开…" : "选择文件夹"}
            </button>
          </div>
          {!isTauri() && (
            <p className="mt-4 rounded-lg bg-secondary px-3 py-2 text-[11.5px] text-muted-foreground">
              浏览器模式没有磁盘权限，选择目录需要在桌面版中使用。
            </p>
          )}
        </div>

        <div className="mt-8 grid grid-cols-3 gap-3">
          {POINTS.map((p) => (
            <div key={p.title} className="rounded-xl border border-border/60 bg-card/60 p-4">
              <p.icon size={15} strokeWidth={1.5} className="text-primary" />
              <div className="mt-2 text-[12.5px] font-medium">{p.title}</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{p.desc}</p>
            </div>
          ))}
        </div>

        <p className="mt-7 text-center text-[11px] leading-relaxed text-muted-foreground">
          也可以选择已有笔记的文件夹，应用会原地读写，不会移动或复制文件。
        </p>
      </div>
    </div>
  );
}
