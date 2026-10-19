import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Check, ChevronDown, Copy, FolderOpen, Keyboard, SlidersHorizontal, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore, normalizeFolder } from "@/store";
import { isTauri } from "@/lib/vault";
import { THEMES } from "@/lib/themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SHORTCUTS = [
  ["Ctrl + P", "快速打开（标题/文件名模糊跳转）"],
  ["Ctrl + N", "快速捕获（回车存为笔记）"],
  ["Ctrl + F", "全文搜索"],
  ["Ctrl + \\", "阅读 / 源码模式切换"],
];

const SECTION_META = [
  { key: "general", label: "通用", icon: SlidersHorizontal },
  { key: "shortcuts", label: "快捷键", icon: Keyboard },
  { key: "mcp", label: "MCP", icon: Terminal },
] as const;

type SectionKey = (typeof SECTION_META)[number]["key"];

type McpPerms = {
  create: boolean;
  update: boolean;
  append: boolean;
  delete: boolean;
  issue_read: boolean;
  issue_write: boolean;
  view_read: boolean;
  view_write: boolean;
};

/** 把选择的目录换算成仓库内相对路径；目录不在仓库内返回 null */
function toRel(root: string, dir: string): string | null {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const lower = d.toLowerCase();
  if (lower === r) return "";
  if (!lower.startsWith(`${r}/`)) return null;
  return d.slice(r.length + 1);
}

/** 设置行：左侧标题+说明，右侧控件 */
function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 py-3.5">
      <div className="min-w-0">
        <div className="text-[13.5px]">{title}</div>
        {desc && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** MCP 写入权限开关 */
function PermSwitch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors",
        on ? "border-primary bg-primary" : "border-border bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-3 rounded-full bg-background shadow transition-[left] duration-150",
          on ? "left-[18px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

export default function SettingsView() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const defaultFolder = useStore((s) => s.defaultFolder);
  const setDefaultFolder = useStore((s) => s.setDefaultFolder);
  const [section, setSection] = useState<SectionKey>("general");
  /** 输入框草稿：失焦/回车时归一化落库 */
  const [dirDraft, setDirDraft] = useState(defaultFolder);
  useEffect(() => setDirDraft(defaultFolder), [defaultFolder]);

  const commitDir = () => {
    const next = normalizeFolder(dirDraft);
    if (next === defaultFolder) setDirDraft(defaultFolder);
    else setDefaultFolder(next);
  };

  const pickDefaultFolder = async () => {
    const root = localStorage.getItem("pkmx.vault.root");
    if (!root) {
      toast.error("请先打开一个仓库", { description: "默认文档地址是仓库内的目录" });
      return;
    }
    const dir = await open({
      directory: true,
      title: "选择默认文档地址（仓库内的子目录）",
      defaultPath: root,
    });
    if (typeof dir !== "string") return;
    const rel = toRel(root, dir);
    if (rel === null) {
      toast.error("该目录不在当前仓库内", { description: root });
      return;
    }
    setDefaultFolder(rel);
  };

  /** MCP 写入权限（桌面模式，Rust 侧持久化到用户配置目录 mcp.json） */
  const [perms, setPerms] = useState<McpPerms | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<McpPerms>("mcp_get_perms")
      .then(setPerms)
      .catch(() => setPerms(null));
  }, []);
  const flipPerm = (k: keyof McpPerms) => {
    if (!perms) return;
    const next = { ...perms, [k]: !perms[k] };
    setPerms(next);
    void invoke("mcp_set_perms", { perms: next }).catch((e) => {
      toast.error("保存 MCP 权限失败", { description: String(e) });
      setPerms(perms);
    });
  };

  /** 接入配置：真实 exe 路径 + 当前主仓库，拼 agent 侧注册 JSON 一键复制 */
  const [exePath, setExePath] = useState("");
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<string>("app_exe_path")
      .then((p) => setExePath(p))
      .catch(() => setExePath(""));
  }, []);
  const vaultRoot = localStorage.getItem("pkmx.vault.root") ?? "";
  const copyMcpConfig = async () => {
    if (!exePath || !vaultRoot) {
      toast.error("暂缺路径信息", { description: "需要可执行文件路径与已打开的本地仓库" });
      return;
    }
    const config = JSON.stringify(
      { mcpServers: { pkmx: { command: exePath, args: ["--mcp", "--vault", vaultRoot] } } },
      null,
      2,
    );
    try {
      await navigator.clipboard.writeText(config);
      toast.success("已复制接入配置", { description: "粘贴到 Claude Code 等 agent 的 MCP 配置即可" });
    } catch (e) {
      toast.error("复制失败", { description: String(e) });
    }
  };

  const curTheme = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  return (
    <section className="flex min-w-0 flex-1 bg-background">
      <div className="flex min-w-0 w-full flex-1 gap-12 px-10 pt-[30px]">
        <div className="w-[150px] shrink-0">
          <h2 className="font-serif text-2xl font-bold">设置</h2>
          <nav className="mt-5 flex flex-col gap-0.5">
            {SECTION_META.map((it) => {
              const on = it.key === section;
              return (
                <button
                  key={it.key}
                  onClick={() => setSection(it.key)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[14px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    on && "bg-accent font-medium text-foreground",
                  )}
                >
                  <span className="grid size-[15px] place-items-center">
                    <it.icon size={14} strokeWidth={1.4} />
                  </span>
                  {it.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* 与左侧菜单列表顶部对齐（容器 30 + 标题 32 + mt-5 20） */}
        <div className="min-w-0 flex-1 overflow-y-auto pt-[52px] pb-12">
          <div className="divide-y divide-border/70">
            {section === "general" && (
              <>
                <Row title="主题颜色">
                  <DropdownMenu>
                    <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] transition-colors hover:bg-accent">
                      <span
                        className="size-3.5 rounded-[4px] border border-border/60"
                        style={{ background: curTheme.dot }}
                      />
                      {curTheme.name}
                      <ChevronDown size={13} className="text-muted-foreground" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[150px]">
                      {THEMES.map((t) => (
                        <DropdownMenuItem key={t.id} onClick={() => setTheme(t.id)} className="gap-2.5 text-[13px]">
                          <span
                            className="size-3.5 shrink-0 rounded-[4px] border border-border/60"
                            style={{ background: t.dot }}
                          />
                          <span className="flex-1">{t.name}</span>
                          {t.id === theme && <Check size={13} className="text-primary" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Row>

                <Row
                  title="默认文档地址"
                  desc={
                    <>
                      软件内新建的笔记（含快速捕获）默认存放在这个目录，留空即仓库根目录。
                      目录是仓库内的相对路径；Issue 独立存储在 .pkmx/issues.json，不受此处影响。
                    </>
                  }
                >
                  <div className="flex items-center gap-2">
                    <input
                      value={dirDraft}
                      onChange={(e) => setDirDraft(e.target.value)}
                      onBlur={commitDir}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitDir();
                        }
                      }}
                      placeholder="根目录"
                      spellCheck={false}
                      className="w-[190px] rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-[12.5px] outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
                    />
                    {isTauri() && (
                      <button
                        onClick={() => void pickDefaultFolder()}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                      >
                        <FolderOpen size={12} strokeWidth={1.5} /> 选择…
                      </button>
                    )}
                  </div>
                </Row>
              </>
            )}

            {section === "shortcuts" &&
              SHORTCUTS.map(([k, d]) => (
                <div key={k} className="flex items-center gap-3 py-2.5 text-xs text-muted-foreground">
                  <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px]">{k}</kbd>
                  {d}
                </div>
              ))}

            {section === "mcp" && (
              <>
                <Row
                  title="MCP 服务器"
                  desc={
                    <>
                      本程序可直接作为 MCP 服务器运行，供 Claude Code 等 agent 读写仓库。笔记工具：
                      search_notes / get_note / create_note / update_note（mtime 守卫）/ append_to_note / delete_note；
                      Issue 工具：list_issues / get_issue / create_issue / update_issue / delete_issue（create_task 为兼容别名）；
                      视图工具：list_views / get_view / run_view / create_view / update_view / delete_view，详见仓库 agent-docs/。
                      写入与删除类工具可在下方单独禁用，对已接入的 agent 即时生效。
                    </>
                  }
                />
                <div className="py-3.5">
                  <code className="block w-fit max-w-full break-all rounded-lg border border-border bg-secondary px-3 py-2 font-mono text-[11px]">
                    {exePath && vaultRoot
                      ? `"${exePath}" --mcp --vault "${vaultRoot}"`
                      : "pkmx.exe --mcp --vault D:\\path\\to\\vault"}
                  </code>
                  {isTauri() && (
                    <button
                      className="mt-2 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                      onClick={() => void copyMcpConfig()}
                    >
                      <Copy size={12} strokeWidth={1.5} /> 复制接入配置（JSON）
                    </button>
                  )}
                </div>
                {perms && (
                  <>
                    <Row title="允许创建笔记">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">create_note</code>
                        <PermSwitch on={perms.create} onChange={() => flipPerm("create")} />
                      </div>
                    </Row>
                    <Row title="允许覆写笔记">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">update_note</code>
                        <PermSwitch on={perms.update} onChange={() => flipPerm("update")} />
                      </div>
                    </Row>
                    <Row title="允许追加内容">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">append_to_note</code>
                        <PermSwitch on={perms.append} onChange={() => flipPerm("append")} />
                      </div>
                    </Row>
                    <Row title="允许删除笔记">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">delete_note</code>
                        <PermSwitch on={perms.delete} onChange={() => flipPerm("delete")} />
                      </div>
                    </Row>
                    <Row title="允许读取 Issue">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">list_issues / get_issue</code>
                        <PermSwitch on={perms.issue_read} onChange={() => flipPerm("issue_read")} />
                      </div>
                    </Row>
                    <Row title="允许管理 Issue">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">
                          create / update / delete_issue · create_task
                        </code>
                        <PermSwitch on={perms.issue_write} onChange={() => flipPerm("issue_write")} />
                      </div>
                    </Row>
                    <Row title="允许读取视图">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">list_views / get_view / run_view</code>
                        <PermSwitch on={perms.view_read} onChange={() => flipPerm("view_read")} />
                      </div>
                    </Row>
                    <Row title="允许管理视图">
                      <div className="flex items-center gap-3">
                        <code className="font-mono text-[11px] text-muted-foreground">create / update / delete_view</code>
                        <PermSwitch on={perms.view_write} onChange={() => flipPerm("view_write")} />
                      </div>
                    </Row>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
