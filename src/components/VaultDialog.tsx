import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, PencilLine, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStore, getVault } from "@/store";
import { isTauri } from "@/lib/vault";
import { cn } from "@/lib/utils";

/** 一排次要操作的小图标按钮 */
function IconBtn({
  title,
  onClick,
  danger,
  children,
}: {
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={cn(
        "grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        danger && "hover:bg-st-blocked/10 hover:text-st-blocked",
      )}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

/** 仓库管理：打开本地仓库、切换/同时加载、重命名、定位、从列表移除 */
export default function VaultDialog({
  open: isOpen,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const registeredVaults = useStore((s) => s.registeredVaults);
  const loadedVaults = useStore((s) => s.loadedVaults);
  const openFolderVault = useStore((s) => s.openFolderVault);
  const addVault = useStore((s) => s.addVault);
  const unloadVault = useStore((s) => s.unloadVault);
  const removeRegisteredVault = useStore((s) => s.removeRegisteredVault);
  const openFolderPath = useStore((s) => s.openFolderPath);
  const renameVault = useStore((s) => s.renameVault);
  const openPrompt = useStore((s) => s.openPrompt);

  const vault = getVault();
  const activeRoot = localStorage.getItem("pkmx.vault.root");
  const isFs = vault.kind === "fs";

  const pick = async () => {
    const dir = await open({ directory: true, title: "选择笔记仓库文件夹" });
    if (typeof dir === "string") {
      await openFolderVault(dir);
      onOpenChange(false);
    }
  };

  const doRename = async (root: string) => {
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
    const v = await openPrompt("重命名仓库", {
      label: `磁盘上的文件夹会整体改名：${root}`,
      value: name,
      placeholder: "新文件夹名",
    });
    if (v?.trim()) void renameVault(root, v.trim());
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(760px,94vw)] gap-0 p-0">
        <DialogHeader className="gap-1.5 border-b border-border/70 px-7 py-5">
          <DialogTitle className="font-serif text-xl">仓库管理</DialogTitle>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            仓库就是一个本地文件夹，应用只读写其中的 Markdown / YAML 与附件。同时加载的仓库会以仓库名为顶层文件夹合并进文件树。
          </p>
        </DialogHeader>

        <div className="flex items-center gap-3 border-b border-border/70 px-7 py-4">
          <button
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => void pick()}
            disabled={!isTauri()}
          >
            <FolderOpen size={14} strokeWidth={1.6} />
            打开本地仓库
          </button>
          <span className="text-[11.5px] text-muted-foreground">
            {isTauri() ? "选一个本地文件夹作为仓库打开" : "浏览器模式无磁盘权限，仓库功能需在桌面版使用"}
          </span>
        </div>

        <div className="max-h-[54vh] overflow-y-auto px-7 py-5">
          <div className="mb-3 flex items-baseline gap-2">
            <span className="text-[13px]">仓库列表</span>
            <span className="text-[11.5px] text-muted-foreground">
              当前：{isFs ? `${vault.rootName} · ${activeRoot ?? ""}` : "内存仓库（不落盘）"}
            </span>
          </div>

          {registeredVaults.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center text-[13px] text-muted-foreground">
              还没有仓库，点上面的「打开本地仓库」选一个文件夹。
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {registeredVaults.map((r) => {
                const name = r.split(/[\\/]/).filter(Boolean).pop() ?? r;
                const isPrimary = r === activeRoot;
                const isLoaded = loadedVaults.includes(r);
                return (
                  <div
                    key={r}
                    className="flex items-center gap-4 rounded-xl border border-border/70 bg-card px-4 py-3.5 transition-colors hover:border-primary/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-medium">{name}</span>
                        {isPrimary && (
                          <span className="shrink-0 rounded border border-primary/40 px-1.5 py-px text-[10.5px] text-primary">主</span>
                        )}
                        {isLoaded && !isPrimary && (
                          <span className="shrink-0 rounded border border-st-done/40 px-1.5 py-px text-[10.5px] text-st-done">已加载</span>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={r}>
                        {r}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {isTauri() && !isLoaded && (
                        <button
                          className="rounded-lg border border-primary/50 px-3 py-1.5 text-[12.5px] text-primary transition-colors hover:bg-accent"
                          onClick={() => (isPrimary ? void openFolderVault(r, false) : void addVault(r))}
                        >
                          {isPrimary ? "打开" : "同时加载"}
                        </button>
                      )}
                      {isTauri() && isLoaded && !isPrimary && (
                        <button
                          className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => unloadVault(r)}
                        >
                          卸载
                        </button>
                      )}
                      {isTauri() && (
                        <>
                          <IconBtn title="重命名（磁盘文件夹整体改名）" onClick={() => void doRename(r)}>
                            <PencilLine size={14} strokeWidth={1.5} />
                          </IconBtn>
                          <IconBtn title="在资源管理器中打开" onClick={() => void openFolderPath(r)}>
                            <FolderOpen size={14} strokeWidth={1.5} />
                          </IconBtn>
                        </>
                      )}
                      <IconBtn title="从列表移除并卸载其文档（不动磁盘文件）" danger onClick={() => removeRegisteredVault(r)}>
                        <Trash2 size={14} strokeWidth={1.5} />
                      </IconBtn>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
