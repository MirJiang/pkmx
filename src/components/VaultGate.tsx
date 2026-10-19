import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "@/store";

export default function VaultGate() {
  const openFolderVault = useStore((s) => s.openFolderVault);

  const pick = async () => {
    const dir = await open({ directory: true, title: "选择笔记仓库文件夹" });
    if (typeof dir === "string") openFolderVault(dir);
  };

  return (
    <div className="grid flex-1 place-items-center bg-background">
      <div className="text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-2xl border border-dashed border-border">
          <span className="font-serif text-3xl text-muted-foreground/40">P</span>
        </div>
        <h2 className="mt-5 font-serif text-lg font-bold">打开一个文件夹作为笔记仓库</h2>
        <p className="mx-auto mt-2 max-w-[380px] text-[13px] leading-relaxed text-muted-foreground">
          仓库就是一个普通文件夹，里面的 Markdown 文件就是笔记。
          <br />
          应用只会读写这个文件夹内的 .md 文件。
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <button
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
            onClick={pick}
          >
            <FolderOpen size={14} strokeWidth={1.6} />
            打开文件夹
          </button>
        </div>
      </div>
    </div>
  );
}
