import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { parseNote, serializeNote, type NoteMeta } from "@/lib/frontmatter";
import { MemoryVault, FsVault, isTauri, type VaultRepo } from "@/lib/vault";
import { isDocFile, toDocNote } from "@/lib/office";
import { TODAY, currentWeek } from "@/lib/dates";
import { toggleTaskInBody, taskLineAt, removeTaskLine, plainTitle } from "@/lib/markdown";
import {
  STATUS_LABEL,
  type Issue,
  type IssueSnapshot,
  type Note,
  type Priority,
  type Status,
} from "@/lib/types";
import { applyTheme, migrateTheme, themeKind } from "@/lib/themes";

export type ViewKind =
  | "note"
  | "board"
  | "archive"
  | "report"
  | "issue"
  | "search"
  | "saved"
  | "settings";
export type EditorMode = "read" | "block" | "source";

/** 保存视图（views/*.yml，扁平过滤） */
export interface SavedView {
  id: string; // views/xxx.yml
  name: string;
  def: {
    status?: Status[];
    priority?: Priority[];
    due?: "all" | "today" | "week" | "overdue";
    text?: string;
  };
}

export function parseViewYml(text: string, id: string): SavedView | null {
  const def: SavedView["def"] = {};
  let name = id.replace(/^views\//, "").replace(/\.yml$/, "");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    const val = v.trim();
    if (k === "name" && val) name = val;
    else if (k === "status" && val) def.status = val.split(",").map((s) => s.trim()) as Status[];
    else if (k === "priority" && val) def.priority = val.split(",").map((s) => s.trim()) as Priority[];
    else if (k === "due" && ["all", "today", "week", "overdue"].includes(val)) def.due = val as SavedView["def"]["due"];
    else if (k === "text" && val) def.text = val;
  }
  return { id, name, def };
}

export function runView(issues: Issue[], v: SavedView): Issue[] {
  const week = currentWeek();
  return issues.filter((n) => {
    if (v.def.status?.length && !v.def.status.includes(n.status)) return false;
    if (v.def.priority?.length && !v.def.priority.includes(n.priority)) return false;
    if (v.def.text && !(`${n.title}\n${n.body}`.toLowerCase().includes(v.def.text.toLowerCase()))) return false;
    if (v.def.due === "today" && n.due !== TODAY) return false;
    if (v.def.due === "overdue" && !(n.due && n.due < TODAY)) return false;
    if (v.def.due === "week" && !(n.due && week.includes(n.due))) return false;
    return true;
  });
}

const newIssueId = (): string =>
  `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/* ---------- 通用输入对话框（替代 window.prompt） ---------- */
export interface PromptState {
  open: boolean;
  title: string;
  label?: string;
  value: string;
  placeholder?: string;
  danger?: boolean;
}
type PromptCb = (value: string | null) => void;
let promptCb: PromptCb = () => {};

/* ---------- 危险操作确认对话框（删除等触及本地文件的操作） ---------- */
export interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
}
type ConfirmCb = (ok: boolean) => void;
let confirmCb: ConfirmCb = () => {};

/* ---------- 附件缓存 ---------- */
const attachmentCache = new Map<string, string>();
export async function getAttachmentUrl(rel: string): Promise<string | null> {
  const hit = attachmentCache.get(rel);
  if (hit) return hit;
  try {
    const url = await repo.readBin(rel);
    attachmentCache.set(rel, url);
    return url;
  } catch {
    return null;
  }
}

let repo: VaultRepo = new MemoryVault();
export const getVault = (): VaultRepo => repo;

/** 在系统资源管理器中显示笔记所在文件（桌面） */
export async function revealNoteInExplorer(note: Note): Promise<void> {
  if (!isTauri()) return;
  const root = note.vaultRoot ?? primaryRoot;
  if (!root || !note.rel) return;
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(`${root}/${note.rel}`.replace(/\\/g, "/"));
  } catch (e) {
    toast.error("打开所在位置失败", { description: String(e) });
  }
}

/** 主仓库根路径（监听事件归属判断用） */
let primaryRoot: string | null = null;
/** 额外同时加载的仓库（会话级） */
const extraVaults = new Map<string, string>(); // root -> vaultName
/** 单文件打开的仓库：只跟踪已注册的 rel，忽略同目录其他文件 */
const vaultOnly = new Map<string, Set<string>>();

/** 每个额外仓库独立的 FsVault 实例缓存 */
const fsVaultCache = new Map<string, FsVault>();
function getFsVault(root: string): FsVault {
  let v = fsVaultCache.get(root);
  if (!v) {
    v = new FsVault(root);
    fsVaultCache.set(root, v);
  }
  return v;
}

/** 该笔记是否为「外部打开的单文件」：其所在目录被注册为受限仓库，只跟踪这一个文件 */
export function isExternalNote(note: Note): boolean {
  return Boolean(note.vaultRoot && vaultOnly.has(note.vaultRoot));
}

/** 同时加载的仓库：顶层节点路径 → 仓库根；非同时加载仓库的顶层节点返回 null */
export function extraVaultRootOf(folder: string): string | null {
  for (const [root, name] of extraVaults) {
    if (folder === name) return root;
  }
  return null;
}

/** 展示用目录路径 → 磁盘位置（同时加载的仓库路径带仓库名前缀，要剥掉） */
function resolveFolder(folder: string): { root: string; rel: string } | null {
  for (const [root, name] of extraVaults) {
    if (folder === name) return { root, rel: "" };
    if (folder.startsWith(`${name}/`)) return { root, rel: folder.slice(name.length + 1) };
  }
  const root = primaryRoot ?? localStorage.getItem("pkmx.vault.root");
  return root ? { root, rel: folder } : null;
}

/** 目录改名后重建受影响笔记的 id / folder / rel（oldF、newF 都是展示用路径） */
function rewriteFolder(notes: Note[], oldF: string, newF: string): Note[] {
  return notes.map((n) => {
    const f = n.folder ?? "";
    if (f !== oldF && !f.startsWith(`${oldF}/`)) return n;
    const folder = f === oldF ? newF : `${newF}${f.slice(oldF.length)}`;
    if (n.vaultRoot) {
      const vn = n.vaultName ?? "";
      const inner = folder === vn ? "" : folder.slice(vn.length + 1);
      const rel = inner ? `${inner}/${n.fileName}` : n.fileName;
      return { ...n, folder, rel, id: `${vn}::${rel}` };
    }
    return { ...n, folder, id: folder ? `${folder}/${n.fileName}` : n.fileName };
  });
}

const vaultNameOf = (root: string): string =>
  root.split(/[\\/]/).filter(Boolean).pop() || "vault";

/** 自己刚写盘的内容（用于过滤 watcher 回声） */
const lastWritten = new Map<string, string>();
const pendingFs = new Map<string, number>();

/* ---------- Issue 独立存储（.pkmx/issues.json） ---------- */
const ISSUE_STORE_REL = ".pkmx/issues.json";
let issueSaveTimer: number | null = null;
let issueSaveChain: Promise<void> = Promise.resolve();
/** 最近一次由本进程写入磁盘的 Issue 快照：用于区分 watcher 回声与真正的外部修改 */
let lastIssuesSaved = "";

function issueWriteTarget(): VaultRepo | null {
  if (!isTauri() || !primaryRoot || repo.kind !== "fs") return null;
  return repo;
}

function persistIssueSnapshot(target: VaultRepo, issues: Issue[]): Promise<void> {
  const snapshot = JSON.stringify(issues);
  issueSaveChain = issueSaveChain.then(async () => {
    try {
      lastIssuesSaved = snapshot;
      const mtime = await target.saveIssues(issues);
      useStore.setState((s) => ({ issuesMtime: Math.max(s.issuesMtime, mtime) }));
    } catch (e) {
      toast.error("Issue 保存失败", { description: String(e) });
    }
  });
  return issueSaveChain;
}

/** 合并高频编辑：400ms 后写盘；写请求串行，避免旧快照覆盖新快照 */
function scheduleIssueSave(delay = 400) {
  const target = issueWriteTarget();
  if (!target) return;
  if (issueSaveTimer !== null) window.clearTimeout(issueSaveTimer);
  issueSaveTimer = window.setTimeout(() => {
    issueSaveTimer = null;
    void persistIssueSnapshot(target, useStore.getState().issues);
  }, delay);
}

async function flushIssueSave() {
  if (issueSaveTimer !== null) {
    window.clearTimeout(issueSaveTimer);
    issueSaveTimer = null;
  }
  const target = issueWriteTarget();
  if (target) await persistIssueSnapshot(target, useStore.getState().issues);
}

export const saveIssuesNow = (): Promise<void> => flushIssueSave();

function weekdayTitle(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(y, m - 1, d).getDay()];
  return `${date} · 周${wd}`;
}

function toNote(relPath: string, text: string, vault?: { root: string; name: string }): Note {
  const { meta, body } = parseNote(text);
  const parts = relPath.split("/");
  const fileName = parts.pop() ?? relPath;
  const innerFolder = parts.join("/");
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : meta.date ? weekdayTitle(meta.date) : fileName.replace(/\.md$/i, "");
  if (vault) {
    return {
      id: `${vault.name}::${relPath}`,
      folder: innerFolder ? `${vault.name}/${innerFolder}` : vault.name,
      fileName,
      title,
      body,
      status: meta.status as Status | undefined,
      priority: meta.priority as Priority | undefined,
      due: meta.due,
      done: meta.done,
      date: meta.date,
      created: meta.created,
      rel: relPath,
      vaultRoot: vault.root,
      vaultName: vault.name,
    };
  }
  return {
    id: relPath,
    folder: innerFolder,
    fileName,
    title,
    body,
    status: meta.status as Status | undefined,
    priority: meta.priority as Priority | undefined,
    due: meta.due,
    done: meta.done,
    date: meta.date,
    created: meta.created,
  };
}

function persistNote(note: Note, rawText?: string) {
  const text = rawText ?? serializeNote(noteMetaOf(note), note.body);
  lastWritten.set(note.id, text);
  const target: VaultRepo = note.vaultRoot ? getFsVault(note.vaultRoot) : repo;
  target.write(note.rel ?? note.id, text).catch((e) => {
    console.error("write failed", note.id, e);
    toast.error(`写入失败：${note.fileName}`, { description: String(e) });
  });
}

function noteMetaOf(note: Note): NoteMeta {
  return {
    status: note.status,
    priority: note.priority,
    due: note.status ? note.due : undefined,
    done: note.done,
    date: note.date,
    created: note.created,
  };
}

/** 打开笔记时从磁盘重读：本地文件永远是唯一事实源，外部修改即时可见 */
async function refreshNoteFromDisk(id: string) {
  if (!isTauri()) return;
  const note = useStore.getState().notes.find((n) => n.id === id);
  if (!note?.rel || note.doc) return; // 文档是二进制，交给 DocView 按需读
  const root = note.vaultRoot ?? primaryRoot;
  if (!root) return;
  try {
    const text = await invoke<string>("vault_read", { root, rel: note.rel });
    const cur = useStore.getState().notes.find((n) => n.id === id);
    if (!cur || useStore.getState().activeId !== id) return; // 用户已切走，不打扰
    if (useStore.getState().editMode !== "read") return; // 正在编辑时不覆盖，避免打断
    if (text === serializeNote(noteMetaOf(cur), cur.body)) return; // 与内存一致
    const next = toNote(
      note.rel,
      text,
      note.vaultRoot ? { root: note.vaultRoot, name: note.vaultName ?? vaultNameOf(root) } : undefined,
    );
    useStore.setState((s) => ({ notes: s.notes.map((n) => (n.id === id ? next : n)) }));
  } catch {
    /* 文件被移动/删除：交给 watcher 同步 */
  }
}

function uniqueRelPath(notes: Note[], fileName: string, folder: string): string {
  let candidate = folder ? `${folder}/${fileName}` : fileName;
  let n = 2;
  const stem = fileName.replace(/\.md$/i, "");
  while (notes.some((x) => x.id === candidate)) candidate = folder ? `${folder}/${stem}-${n++}.md` : `${stem}-${n++}.md`;
  return candidate;
}

function sanitizeFileName(title: string): string {
  return (title.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名").slice(0, 60);
}

/** 启动仓库文件监听（仅 Tauri；每个仓库一个 watcher，事件带 root 归属） */
const watchedRoots = new Set<string>();
let listenerBound = false;
/** Rust 事件的 root 统一为 /，本地存储的是平台原始路径，匹配前先归一化 */
const rootKey = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
function startWatcher(root: string) {
  if (!isTauri() || watchedRoots.has(root)) return;
  watchedRoots.add(root);
  if (!listenerBound) {
    listenerBound = true;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<{ root: string; rel: string; kind: string }>("vault-fs-event", (ev) => {
        const { rel, kind } = ev.payload;
        const evRoot = rootKey(ev.payload.root);
        const actualRoot =
          primaryRoot && rootKey(primaryRoot) === evRoot
            ? primaryRoot
            : [...extraVaults.keys()].find((r) => rootKey(r) === evRoot);
        // 仓库已卸载/移除：Rust 侧 watcher 仍在，但事件不再回流到文件树
        if (!actualRoot) return;
        const key = actualRoot === primaryRoot ? rel : `${vaultNameOf(actualRoot)}::${rel}`;
        const prev = pendingFs.get(key);
        if (prev) clearTimeout(prev);
        pendingFs.set(
          key,
          window.setTimeout(async () => {
            pendingFs.delete(key);
            if (actualRoot !== primaryRoot && !extraVaults.has(actualRoot)) return; // 去抖窗口内仓库已被移除
            // Issue 独立存储：只跟随主仓库；外部（MCP/手工）改动后热更新
            if (rel === ISSUE_STORE_REL) {
              if (actualRoot !== primaryRoot || kind === "remove") return;
              try {
                const snap = await invoke<IssueSnapshot>("vault_issues_load", { root: actualRoot });
                const incoming = JSON.stringify(snap.issues);
                const state = useStore.getState();
                if (incoming !== lastIssuesSaved && incoming !== JSON.stringify(state.issues)) {
                  useStore.setState({ issues: snap.issues, issuesMtime: snap.mtime });
                  lastIssuesSaved = incoming;
                } else {
                  useStore.setState({ issuesMtime: snap.mtime });
                  if (incoming === JSON.stringify(state.issues)) lastIssuesSaved = incoming;
                }
                const gone = new Set([...snap.migrated, ...snap.removed]);
                if (gone.size) {
                  useStore.setState((s) => ({
                    notes: s.notes.filter((n) => !(n.rel && gone.has(n.rel))),
                  }));
                }
              } catch {
                /* 文件正在被替换：等待下一次事件 */
              }
              return;
            }
            // 隐藏目录（.pkmx 的 Issue 存储与旧任务备份）不进入文件树
            if (rel.split("/").some((seg) => seg.startsWith("."))) return;
            if (kind === "remove") {
              useStore.setState((s) => ({
                notes: s.notes.filter((n) => n.id !== key),
                views: s.views.filter((v) => v.id !== key),
              }));
              return;
            }
            try {
              const text = await invoke<string>("vault_read", { root: actualRoot, rel });
              if (lastWritten.get(key) === text) {
                lastWritten.delete(key); // 自己的写入回声，跳过一次
                return;
              }
              const vault = actualRoot === primaryRoot ? undefined : { root: actualRoot, name: vaultNameOf(actualRoot) };
              if (!vault && rel.startsWith("views/") && rel.endsWith(".yml")) {
                const v = parseViewYml(text, rel);
                if (v) {
                  useStore.setState((s) => ({
                    views: s.views.some((x) => x.id === rel) ? s.views.map((x) => (x.id === rel ? v : x)) : [...s.views, v],
                  }));
                }
                return;
              }
              if (!rel.toLowerCase().endsWith(".md") && !isDocFile(rel)) return;
              if (actualRoot !== primaryRoot) {
                const only = vaultOnly.get(actualRoot);
                if (only && !only.has(rel)) return; // 单文件打开的目录：只跟踪已注册文件
              }
              const next = isDocFile(rel)
                ? toDocNote(rel, vault)
                : toNote(rel, text, vault);
              useStore.setState((s) => {
                const exists = s.notes.some((n) => n.id === next.id);
                return {
                  notes: exists ? s.notes.map((n) => (n.id === next.id ? next : n)) : [...s.notes, next],
                };
              });
            } catch {
              /* 事件与读取之间文件又被删掉，忽略 */
            }
          }, 250),
        );
      });
    });
  }
  void invoke("vault_watch", { root }).catch((e) => console.error("watch failed", e));
}

/* ---------- 多仓库注册表 ---------- */
function loadRegistered(): string[] {
  try {
    return JSON.parse(localStorage.getItem("pkmx.vaults") ?? "[]");
  } catch {
    return [];
  }
}
function saveRegistered(list: string[]) {
  localStorage.setItem("pkmx.vaults", JSON.stringify([...new Set(list)]));
}

/* ---------- 默认文档地址 ---------- */
const DEFAULT_FOLDER_KEY = "pkmx.defaultFolder";

/** 归一化仓库内相对目录：统一分隔符、丢掉空段与 .、含 .. 视为越界退回根目录 */
export function normalizeFolder(input: string): string {
  const segs = input
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== ".");
  return segs.includes("..") ? "" : segs.join("/");
}

function loadDefaultFolder(): string {
  return normalizeFolder(localStorage.getItem(DEFAULT_FOLDER_KEY) ?? "");
}

/* ---------- 会话状态持久化：同时加载的仓库 / 外部单文件 / 上次的视图与笔记 ----------
 * 重启与热重载后按这些键恢复现场；文件清单本身不记录（文件系统是唯一事实源，每次实时扫描）。 */
const LOADED_KEY = "pkmx.vaults.loaded";
const EXTFILES_KEY = "pkmx.vaults.files";
const SESSION_KEY = "pkmx.session";

function saveLoadedVaults(list: string[]) {
  const primary = localStorage.getItem("pkmx.vault.root");
  localStorage.setItem(
    LOADED_KEY,
    JSON.stringify(list.filter((r) => r !== primary && !vaultOnly.has(r))),
  );
}

function saveExternalFiles() {
  const out: { root: string; rels: string[] }[] = [];
  for (const [root, rels] of vaultOnly) out.push({ root, rels: [...rels] });
  localStorage.setItem(EXTFILES_KEY, JSON.stringify(out));
}

async function loadInto(next: VaultRepo): Promise<{
  notes: Note[];
  views: SavedView[];
  issues: Issue[];
  issuesMtime: number;
  migrated: string[];
}> {
  repo = next;
  // 先加载 Issue：首次会迁移旧任务并删掉原 Markdown，再列文件才不会把旧任务当普通笔记
  const issueSnap = await next.loadIssues();
  lastIssuesSaved = JSON.stringify(issueSnap.issues);
  const files = await next.loadAll();
  const gone = new Set([...issueSnap.migrated, ...issueSnap.removed]);
  const notes: Note[] = [];
  const views: SavedView[] = [];
  for (const f of files) {
    if (f.relPath.split("/").some((seg) => seg.startsWith("."))) continue; // 跳过 .pkmx 等隐藏目录
    if (gone.has(f.relPath)) continue;
    if (f.relPath.startsWith("views/") && f.relPath.endsWith(".yml")) {
      const v = parseViewYml(f.text, f.relPath);
      if (v) views.push(v);
    } else if (isDocFile(f.relPath)) {
      notes.push(toDocNote(f.relPath)); // 办公文档：只展示与定位
    } else {
      notes.push(toNote(f.relPath, f.text));
    }
  }
  notes.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  views.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { notes, views, issues: issueSnap.issues, issuesMtime: issueSnap.mtime, migrated: issueSnap.migrated };
}

interface AppState {
  ready: boolean;
  needsVault: boolean;
  notes: Note[];
  /** 项目 Issue：独立 JSON 存储，和 Markdown 笔记互不混合 */
  issues: Issue[];
  views: SavedView[];
  activeId: string | null;
  activeIssueId: string | null;
  /** .pkmx/issues.json 的 mtime（unix 毫秒），用于判断外部修改 */
  issuesMtime: number;
  view: ViewKind;
  viewId: string | null; // 保存视图 id
  /** 编辑器三态：阅读 / 块编辑（点击段落就地编辑）/ 源码（整文件直编） */
  editMode: EditorMode;
  wide: boolean;
  openFolders: Record<string, boolean>;
  theme: string;
  captureOpen: boolean;
  captureStatus: Status | null;
  quickOpenOpen: boolean;
  prompt: PromptState;
  confirm: ConfirmState;
  /** 注入区已固化的块（会话级） */
  pinnedInjections: Record<string, string[]>;
  registeredVaults: string[];
  /** 当前已加载（主 + 同时加载）的仓库根路径 */
  loadedVaults: string[];
  /** 软件内新建笔记（含快速捕获）的默认目录：仓库内相对路径，空串 = 仓库根目录 */
  defaultFolder: string;

  init(): Promise<void>;
  openFolderVault(root: string, register?: boolean): Promise<void>;
  /** 同时加载：合并另一个仓库进当前树 */
  addVault(root: string, silent?: boolean): Promise<void>;
  unloadVault(root: string): void;
  removeRegisteredVault(root: string): void;
  /** 设置默认文档地址（仓库内相对目录；空串 = 根目录） */
  setDefaultFolder(folder: string): void;
  /** 从树中移除「外部打开的单文件」（磁盘文件不动，仅注销受限跟踪） */
  forgetExternalFile(id: string): void;
  setView(view: ViewKind, activeId?: string | null, viewId?: string | null): void;
  openNote(id: string): void;
  /** 打开项目 Issue（独立于笔记） */
  openIssue(id: string): void;
  createIssue(
    title: string,
    opts?: { status?: Status; priority?: Priority; due?: string; body?: string; open?: boolean },
  ): string | null;
  updateIssue(
    id: string,
    patch: Partial<Pick<Issue, "title" | "body" | "status" | "priority" | "due">>,
  ): void;
  deleteIssue(id: string): void;
  openOrCreateByTitle(title: string): void;
  confirmCreate(title: string): void;
  updateBody(id: string, body: string): void;
  updateRaw(id: string, raw: string): void;
  toggleTask(id: string, idx: number): void;
  /** 笔记勾选项 → 独立 Issue（同时从正文移除该行） */
  checkboxToIssue(id: string, idx: number): void;
  pinInjection(noteId: string, which: string): void;
  capture(title: string, asIssue: boolean): void;
  createNoteIn(title: string, folder: string): void;
  /** 新建子文件夹：按约定写入同名占位笔记（文件系统里空目录不保留） */
  createSubFolder(parent: string, name: string): void;
  /** 文件夹重命名（同层改名；磁盘目录整体改名，笔记/办公文档/附件一并跟随） */
  renameFolder(folder: string, newName: string): Promise<void>;
  /** 递归删除文件夹及其全部内容（不可恢复，调用方需先确认） */
  deleteFolder(folder: string): Promise<void>;
  /** 在系统资源管理器中打开文件夹 */
  revealFolder(folder: string): Promise<void>;
  /** 在系统资源管理器中打开任意目录路径（仓库根用） */
  openFolderPath(path: string): Promise<void>;
  /** 仓库重命名：真正改磁盘上的仓库文件夹名，注册表/当前仓库/已加载状态/笔记路径同步更新 */
  renameVault(root: string, newName: string): Promise<void>;
  moveNote(id: string, folder: string): void;
  renameNote(id: string, newFileName: string): void;
  deleteNote(id: string): void;
  deleteView(id: string): void;
  toggleFolder(name: string): void;
  toggleTheme(): void;
  setTheme(id: string): void;
  setCaptureOpen(open: boolean, status?: Status | null): void;
  setQuickOpenOpen(open: boolean): void;
  cycleEditMode(): void;
  setEditMode(mode: EditorMode): void;
  toggleWide(): void;
  ensureDaily(): string | null;
  /** 阅读模式：把正文中选中的文字包成 [[双链]] */
  linkSelection(id: string, text: string): void;
  openPrompt(title: string, opts?: { label?: string; value?: string; placeholder?: string }): Promise<string | null>;
  answerPrompt(value: string | null): void;
  /** 危险操作确认；resolve(true)=确认执行 */
  openConfirm(title: string, message: string, opts?: { okLabel?: string; danger?: boolean }): Promise<boolean>;
  answerConfirm(ok: boolean): void;
  writeAttachment(dataUrl: string, ext: string): Promise<string>;
  /** 打开（桌面）：文件夹作为仓库加入，.md 文件原地读写（不复制） */
  openPaths(paths: string[]): Promise<void>;
  /** 打开单个外部 .md：目录注册为受限仓库，只跟踪该文件 */
  openExternalFile(path: string, silent?: boolean): Promise<void>;
  /** 启动时恢复会话状态（同时加载的仓库、外部单文件、上次视图与笔记） */
  restoreDesktopState(): Promise<void>;
  restoreSessionView(): void;
  /** 导入（浏览器/内存仓库）：拖放读到的 .md 内容直接写入当前仓库 */
  importTexts(entries: { path: string; text: string }[]): void;
}

export const useStore = create<AppState>((set, get) => ({
  ready: false,
  needsVault: false,
  notes: [],
  issues: [],
  views: [],
  activeId: null,
  activeIssueId: null,
  issuesMtime: 0,
  view: "note",
  viewId: null,
  editMode: (["read", "block", "source"] as const).includes(
    localStorage.getItem("pkmx.editMode") as EditorMode,
  )
    ? (localStorage.getItem("pkmx.editMode") as EditorMode)
    : "read",
  wide: false,
  openFolders: {},
  theme: migrateTheme(localStorage.getItem("pkmx.theme")),
  captureOpen: false,
  captureStatus: null,
  quickOpenOpen: false,
  prompt: { open: false, title: "", value: "" },
  confirm: { open: false, title: "", message: "" },
  pinnedInjections: {},
  registeredVaults: loadRegistered(),
  loadedVaults: [],
  defaultFolder: loadDefaultFolder(),

  async init() {
    // StrictMode（dev）下 effect 双调用：init 只跑一次，否则第二次会用默认值
    // 盖掉第一次刚恢复的会话现场（视图/笔记/已加载仓库）
    if (initRan) return;
    initRan = true;
    // 「隐藏项」功能已移除（2026-10-16）：清掉历史遗留的隐藏表
    localStorage.removeItem("pkmx.hidden");
    applyTheme(get().theme);
    if (!isTauri()) {
      // 浏览器开发：落到内存仓库（无磁盘权限，刷新即空）。恢复现场须在 ready 翻转前完成，
      // 否则记录器会把默认视图覆写进 session，恢复读到的是被覆写的值
      const { notes, views, issues } = await loadInto(new MemoryVault());
      set({ notes, views, issues, activeId: notes[0]?.id ?? null });
      get().restoreSessionView();
      set({ ready: true });
      return;
    }
    // 默认文档地址由 GUI 与 MCP 共用：以共享配置为准，旧版本只有 localStorage 时迁移过去
    try {
      const central = normalizeFolder(await invoke<string>("app_get_default_folder"));
      if (central) {
        localStorage.setItem(DEFAULT_FOLDER_KEY, central);
        set({ defaultFolder: central });
      } else {
        const local = loadDefaultFolder();
        if (local) await invoke("app_set_default_folder", { folder: local });
      }
    } catch {
      /* 命令不可用时沿用 localStorage */
    }
    const saved = localStorage.getItem("pkmx.vault.root");
    if (saved) {
      try {
        const { notes, views, issues, issuesMtime, migrated } = await loadInto(new FsVault(saved));
        primaryRoot = saved;
        startWatcher(saved);
        set({ notes, views, issues, issuesMtime, activeId: notes[0]?.id ?? null, loadedVaults: [saved] });
        if (migrated.length) {
          toast.success(`已把 ${migrated.length} 个旧任务迁移为 Issue`, {
            description: "原 Markdown 已备份到 .pkmx/legacy-backup/",
          });
        }
        await get().restoreDesktopState();
        set({ ready: true });
        return;
      } catch (e) {
        toast.error("仓库打开失败，请重新选择", { description: String(e) });
      }
    }
    // GUI 启动参数 --vault <dir>：直接打开指定仓库
    try {
      const initial = await invoke<string | null>("initial_vault");
      if (initial) {
        await get().openFolderVault(initial);
        await get().restoreDesktopState();
        set({ ready: true });
        return;
      }
    } catch {
      /* 命令不可用或路径失效时回落到选择界面 */
    }
    set({ needsVault: true, ready: true });
  },

  /** 启动恢复：静默重载上次同时加载的仓库与外部单文件，再回到上次的视图/笔记；失效路径自动剪除 */
  async restoreDesktopState() {
    if (!isTauri()) return;
    let extras: string[] = [];
    try {
      extras = JSON.parse(localStorage.getItem(LOADED_KEY) ?? "[]");
    } catch {
      /* 坏数据当作空 */
    }
    const primary = localStorage.getItem("pkmx.vault.root");
    for (const r of extras) {
      if (typeof r !== "string" || r === primary) continue;
      await get().addVault(r, true);
    }
    saveLoadedVaults(get().loadedVaults); // 目录已消失的条目就此剪掉
    let exts: { root: string; rels: string[] }[] = [];
    try {
      exts = JSON.parse(localStorage.getItem(EXTFILES_KEY) ?? "[]");
    } catch {
      /* 坏数据当作空 */
    }
    for (const e of exts) {
      if (!e?.root || !Array.isArray(e.rels)) continue;
      for (const rel of e.rels) {
        if (typeof rel !== "string") continue;
        await get().openExternalFile(`${e.root}/${rel}`.replace(/\\/g, "/"), true);
      }
    }
    saveExternalFiles();
    get().restoreSessionView();
  },

  /** 校验并恢复上次的视图与笔记（笔记/视图/Issue 已不存在则保持默认） */
  restoreSessionView() {
    let s: { view?: string; viewId?: string | null; activeId?: string | null; activeIssueId?: string | null } | null =
      null;
    try {
      s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    } catch {
      s = null;
    }
    const KINDS: ViewKind[] = ["note", "board", "archive", "report", "issue", "search", "saved", "settings"];
    if (!s || !s.view || !KINDS.includes(s.view as ViewKind)) return;
    const view = s.view as ViewKind;
    const st = get();
    if (view === "saved" && !st.views.some((v) => v.id === s.viewId)) return;
    const activeOk = s.activeId && st.notes.some((n) => n.id === s.activeId) ? s.activeId : null;
    const issueOk =
      s.activeIssueId && st.issues.some((i) => i.id === s.activeIssueId) ? s.activeIssueId : null;
    if (view === "note" && !activeOk) return;
    if (view === "issue" && !issueOk) return;
    set({
      view,
      viewId: view === "saved" ? s.viewId ?? null : null,
      activeId: activeOk ?? st.activeId,
      activeIssueId: view === "issue" ? issueOk : null,
      editMode: "read",
    });
  },

  async openFolderVault(root, register = true) {
    try {
      const { notes, views, issues, issuesMtime, migrated } = await loadInto(new FsVault(root));
      localStorage.setItem("pkmx.vault.root", root);
      primaryRoot = root;
      extraVaults.clear();
      vaultOnly.clear();
      localStorage.removeItem(LOADED_KEY); // 切换主仓库会重置已加载集合
      localStorage.removeItem(EXTFILES_KEY);
      if (register) {
        const list = [...loadRegistered(), root];
        saveRegistered(list);
        set({ registeredVaults: list });
      }
      startWatcher(root);
      set({
        notes,
        views,
        issues,
        issuesMtime,
        needsVault: false,
        activeId: notes[0]?.id ?? null,
        activeIssueId: null,
        view: "note",
        loadedVaults: [root],
      });
      if (migrated.length) {
        toast.success(`已把 ${migrated.length} 个旧任务迁移为 Issue`, {
          description: "原 Markdown 已备份到 .pkmx/legacy-backup/",
        });
      }
      toast.success(`已打开仓库：${repo.rootName} · ${notes.length} 篇笔记`);
    } catch (e) {
      toast.error("打开仓库失败", { description: String(e) });
    }
  },

  /** 同时加载：把另一个已注册仓库合并进当前文件树（顶层以仓库名为文件夹） */
  async addVault(root, silent = false) {
    if (!isTauri()) {
      if (!silent) toast("同时加载仅桌面模式可用");
      return;
    }
    if (root === primaryRoot) {
      if (!silent) toast("该仓库已是主仓库");
      return;
    }
    try {
      const v = getFsVault(root);
      const files = await v.loadAll();
      const name = vaultNameOf(root);
      const incoming: Note[] = [];
      const incomingViews: SavedView[] = [];
      for (const f of files) {
        if (f.relPath.startsWith("views/") && f.relPath.endsWith(".yml")) {
          const sv = parseViewYml(f.text, `views/${name}__${f.relPath.replace(/^views\//, "")}`);
          if (sv) incomingViews.push(sv);
        } else {
          incoming.push(isDocFile(f.relPath) ? toDocNote(f.relPath, { root, name }) : toNote(f.relPath, f.text, { root, name }));
        }
      }
      extraVaults.set(root, name);
      startWatcher(root);
      set((s) => ({
        notes: [...s.notes, ...incoming],
        views: [...s.views, ...incomingViews],
        loadedVaults: [...s.loadedVaults.filter((r) => r !== root), root],
        registeredVaults: s.registeredVaults.includes(root) ? s.registeredVaults : [...s.registeredVaults, root],
      }));
      saveLoadedVaults(get().loadedVaults);
      if (!loadRegistered().includes(root)) {
        saveRegistered([...loadRegistered(), root]);
      }
      if (!silent) toast.success(`已同时加载仓库 ${name} · ${incoming.length} 篇笔记`);
    } catch (e) {
      if (!silent) toast.error("加载仓库失败", { description: String(e) });
    }
  },

  unloadVault(root) {
    const name = extraVaults.get(root);
    if (!name) return;
    extraVaults.delete(root);
    // 保留 watchedRoots：Rust 侧 watcher 无法注销，删掉会导致重新加载时重复注册
    if (vaultOnly.delete(root)) saveExternalFiles();
    const viewPrefix = `views/${name}__`;
    set((s) => {
      const notes = s.notes.filter((n) => n.vaultRoot !== root);
      const views = s.views.filter((v) => !v.id.startsWith(viewPrefix));
      const viewId = views.some((v) => v.id === s.viewId) ? s.viewId : null;
      return {
        notes,
        views,
        viewId,
        view: s.view === "saved" && !viewId ? "board" : s.view,
        activeId: notes.some((n) => n.id === s.activeId) ? s.activeId : notes[0]?.id ?? null,
        openFolders: Object.fromEntries(
          Object.entries(s.openFolders).filter(([k]) => k !== name && !k.startsWith(`${name}/`)),
        ),
        loadedVaults: s.loadedVaults.filter((r) => r !== root),
      };
    });
    saveLoadedVaults(get().loadedVaults);
    toast(`已卸载仓库 ${name}（文件保留在磁盘）`);
  },

  removeRegisteredVault(root) {
    const list = loadRegistered().filter((r) => r !== root);
    saveRegistered(list);
    const name = vaultNameOf(root);
    const isPrimary = root === primaryRoot;
    const isExtra = extraVaults.has(root);

    if (isExtra) {
      extraVaults.delete(root);
      vaultOnly.delete(root);
      fsVaultCache.delete(root);
      saveExternalFiles();
    }
    if (isPrimary) {
      // 移除当前主仓库：连同同时加载的仓库一起关闭，回到选择仓库界面（磁盘文件不动）
      primaryRoot = null;
      localStorage.removeItem("pkmx.vault.root");
      localStorage.removeItem(LOADED_KEY);
      localStorage.removeItem(EXTFILES_KEY);
      extraVaults.clear();
      vaultOnly.clear();
      fsVaultCache.clear();
      repo = new MemoryVault();
      lastIssuesSaved = "";
      if (issueSaveTimer !== null) {
        window.clearTimeout(issueSaveTimer);
        issueSaveTimer = null;
      }
    }

    if (!isPrimary && !isExtra) {
      set({ registeredVaults: list });
      toast(`已从仓库列表移除 ${name}（磁盘文件未改动）`);
      return;
    }

    const viewPrefix = `views/${name}__`;
    set((s) => {
      const notes = isPrimary ? [] : s.notes.filter((n) => n.vaultRoot !== root);
      const views = isPrimary ? [] : s.views.filter((v) => !v.id.startsWith(viewPrefix));
      const viewId = views.some((v) => v.id === s.viewId) ? s.viewId : null;
      return {
        registeredVaults: list,
        notes,
        issues: isPrimary ? [] : s.issues,
        activeIssueId: isPrimary ? null : s.activeIssueId,
        issuesMtime: isPrimary ? 0 : s.issuesMtime,
        views,
        viewId,
        view: isPrimary ? (s.view === "settings" ? "settings" : "note") : s.view === "saved" && !viewId ? "board" : s.view,
        activeId: notes.some((n) => n.id === s.activeId) ? s.activeId : notes[0]?.id ?? null,
        openFolders: isPrimary
          ? {}
          : Object.fromEntries(
              Object.entries(s.openFolders).filter(([k]) => k !== name && !k.startsWith(`${name}/`)),
            ),
        loadedVaults: isPrimary ? [] : s.loadedVaults.filter((r) => r !== root),
        needsVault: isPrimary ? true : s.needsVault,
      };
    });
    saveLoadedVaults(get().loadedVaults);
    toast.success(`已移除仓库 ${name}，对应文档已从文件树移除（磁盘文件未改动）`);
  },

  setDefaultFolder(folder) {
    const dir = normalizeFolder(folder);
    if (dir) localStorage.setItem(DEFAULT_FOLDER_KEY, dir);
    else localStorage.removeItem(DEFAULT_FOLDER_KEY);
    set({ defaultFolder: dir });
    if (isTauri()) {
      void invoke("app_set_default_folder", { folder: dir }).catch((e) =>
        toast.error("保存默认文档地址失败", { description: String(e) }),
      );
    }
  },

  forgetExternalFile(id) {
    const st = get();
    const note = st.notes.find((n) => n.id === id);
    const root = note?.vaultRoot;
    if (!note || !root || !vaultOnly.has(root)) return;
    // 外部单文件：从受限跟踪里注销；该目录空了就整体清掉
    const only = vaultOnly.get(root)!;
    only.delete(note.rel ?? note.id);
    if (!only.size) {
      vaultOnly.delete(root);
      extraVaults.delete(root);
      watchedRoots.delete(root);
    }
    saveExternalFiles();
    const rest = st.notes.filter((n) => n.id !== id);
    set({ notes: rest, activeId: st.activeId === id ? rest[0]?.id ?? null : st.activeId });
    toast(`已从列表移除「${note.title}」（磁盘文件未改动）`);
  },

  setView(view, activeId, viewId) {
    set((s) => ({
      view,
      viewId: viewId !== undefined ? viewId : s.viewId,
      activeId: activeId !== undefined ? activeId : s.activeId,
      activeIssueId: view === "issue" ? s.activeIssueId : null,
      editMode: "read",
    }));
  },

  openNote(id) {
    set({ view: "note", activeId: id, activeIssueId: null, editMode: "read" });
    void refreshNoteFromDisk(id);
  },

  openIssue(id) {
    if (!get().issues.some((i) => i.id === id)) return;
    set({ view: "issue", activeIssueId: id, editMode: "read" });
  },

  createIssue(title, opts) {
    if (get().needsVault) {
      toast.error("请先打开一个文件夹作为仓库", { description: "Issue 数据保存在仓库的 .pkmx/issues.json" });
      return null;
    }
    const t = title.trim();
    if (!t) return null;
    const issue: Issue = {
      id: newIssueId(),
      title: t,
      body: opts?.body ?? "",
      status: opts?.status ?? "Todo",
      priority: opts?.priority ?? "Normal",
      due: opts?.due || undefined,
      done: (opts?.status ?? "Todo") === "Done" ? TODAY : undefined,
      created: TODAY,
      updated: TODAY,
    };
    set((s) => ({
      issues: [issue, ...s.issues],
      ...(opts?.open === false
        ? {}
        : { view: "issue" as ViewKind, activeIssueId: issue.id, activeId: s.activeId }),
    }));
    scheduleIssueSave(0);
    toast.success(`已创建 Issue《${t}》`);
    return issue.id;
  },

  updateIssue(id, patch) {
    set((s) => ({
      issues: s.issues.map((i) => {
        if (i.id !== id) return i;
        if (patch.title !== undefined && !patch.title.trim()) return i;
        const status = patch.status ?? i.status;
        return {
          ...i,
          ...patch,
          status,
          done: status === "Done" ? i.done ?? TODAY : undefined,
          updated: TODAY,
        };
      }),
    }));
    scheduleIssueSave();
  },

  deleteIssue(id) {
    const issue = get().issues.find((i) => i.id === id);
    if (!issue) return;
    set((s) => ({
      issues: s.issues.filter((i) => i.id !== id),
      activeIssueId: s.activeIssueId === id ? null : s.activeIssueId,
      view: s.activeIssueId === id ? "board" : s.view,
    }));
    scheduleIssueSave(0);
    toast.success(`已删除 Issue《${issue.title}》`);
  },

  openOrCreateByTitle(title) {
    const hit = get().notes.find((n) => n.title === title);
    if (hit) {
      set({ view: "note", activeId: hit.id, editMode: "read" });
      return;
    }
    const fileName = `${sanitizeFileName(title)}.md`;
    const id = uniqueRelPath(get().notes, fileName, "");
    const note: Note = { id, folder: "", fileName, title, body: "", created: TODAY };
    persistNote(note);
    set((s) => ({ notes: [...s.notes, note], view: "note", activeId: id, editMode: "read" }));
    toast.success(`已创建笔记《${title}》`);
  },

  /** 未解析双链：先确认再创建（防误触） */
  confirmCreate(title) {
    if (get().notes.some((n) => n.title === title)) {
      get().openOrCreateByTitle(title);
      return;
    }
    toast(`《${title}》尚不存在`, {
      duration: 6000,
      action: { label: "创建", onClick: () => get().openOrCreateByTitle(title) },
    });
  },

  updateBody(id, body) {
    set((s) => {
      const notes = s.notes.map((n) => {
        if (n.id !== id) return n;
        const h1 = body.match(/^#\s+(.+)$/m);
        return { ...n, body, title: h1 ? h1[1].trim() : n.title };
      });
      const note = notes.find((n) => n.id === id);
      if (note) persistNote(note);
      return { notes };
    });
  },

  /** 源码模式：整文件编辑（含 frontmatter），按原文写盘 */
  updateRaw(id, raw) {
    const { meta, body } = parseNote(raw);
    const h1 = body.match(/^#\s+(.+)$/m);
    set((s) => {
      const notes = s.notes.map((n) =>
        n.id === id
          ? {
              ...n,
              body,
              title: h1 ? h1[1].trim() : n.title,
              status: meta.status as Status | undefined,
              priority: meta.priority as Priority | undefined,
              due: meta.due,
              done: meta.done,
              date: meta.date,
              created: meta.created ?? n.created,
            }
          : n,
      );
      lastWritten.set(id, raw);
      const target = notes.find((n) => n.id === id);
      const vaultRepo = target?.vaultRoot ? getFsVault(target.vaultRoot) : repo;
      vaultRepo
        .write(target?.rel ?? id, raw)
        .catch((e) => toast.error(`写入失败：${id}`, { description: String(e) }));
      return { notes };
    });
  },

  toggleTask(id, idx) {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    get().updateBody(id, toggleTaskInBody(note.body, idx));
  },

  /** 笔记勾选项 → 独立 Issue（不生成 Markdown 文件） */
  checkboxToIssue(id, idx) {
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    const line = taskLineAt(note.body, idx);
    if (!line) return;
    const title = plainTitle(line.text) || "未命名 Issue";
    get().createIssue(title, {
      status: "Todo",
      due: line.due || undefined,
      body: `来自笔记 [[${note.title}]] 的勾选项。\n`,
      open: false,
    });
    get().updateBody(id, removeTaskLine(note.body, idx));
    toast.success(`已转为 Issue《${title}》，可在看板中查看`);
  },

  /** 注入区固化为正文 */
  pinInjection(noteId, which) {
    const s = get();
    const note = s.notes.find((n) => n.id === noteId);
    if (!note) return;
    const format = (i: Issue) =>
      `- ${i.title}（${STATUS_LABEL[i.status]}${i.due ? ` · ${i.due}` : ""}）`;
    let md = "";
    if (which === "due") {
      const rows = s.issues
        .filter((i) => i.status !== "Done" && Boolean(i.due && i.due <= TODAY))
        .sort((a, b) => (a.due! < b.due! ? -1 : 1))
        .map(format)
        .join("\n");
      md = `\n## 今日到期（固化于 ${new Date().toTimeString().slice(0, 5)}）\n${rows || "- （当时无到期 Issue）"}\n`;
    } else {
      const rows = s.issues.filter((i) => i.done === TODAY).map(format).join("\n");
      md = `\n## 今日完成（固化于 ${new Date().toTimeString().slice(0, 5)}）\n${rows || "- （当时无完成 Issue）"}\n`;
    }
    get().updateBody(noteId, note.body.replace(/\s*$/, "") + md);
    set((st) => ({ pinnedInjections: { ...st.pinnedInjections, [noteId]: [...(st.pinnedInjections[noteId] ?? []), which] } }));
    toast.success("已固化为正文静态文本");
  },

  capture(title, asIssue) {
    if (get().needsVault) {
      toast.error("请先打开一个文件夹作为仓库", { description: "便签需要保存在仓库目录里" });
      return;
    }
    const preset = get().captureStatus;
    if (asIssue) {
      get().createIssue(title, { status: preset ?? "Todo" });
      set({ captureOpen: false, captureStatus: null });
      return;
    }
    const target = get().defaultFolder;
    const fileName = `${sanitizeFileName(title)}.md`;
    const id = uniqueRelPath(get().notes, fileName, target);
    const note: Note = {
      id,
      folder: target,
      fileName,
      title,
      body: "",
      created: TODAY,
    };
    persistNote(note);
    set((s) => ({ notes: [note, ...s.notes], captureOpen: false, captureStatus: null }));
    toast.success(`笔记已保存到 ${target || "根目录"}`);
  },

  createNoteIn(title, folder) {
    if (get().needsVault) {
      toast.error("请先打开一个文件夹作为仓库", { description: "新建的笔记需要保存在仓库目录里" });
      return;
    }
    const target = folder || get().defaultFolder;
    const fileName = `${sanitizeFileName(title)}.md`;
    const id = uniqueRelPath(get().notes, fileName, target);
    const note: Note = {
      id,
      folder: target,
      fileName,
      title,
      body: `# ${title}\n\n`,
      created: TODAY,
    };
    persistNote(note);
    set((s) => ({
      notes: [...s.notes, note],
      activeId: id,
      view: "note",
      openFolders: target ? { ...s.openFolders, [target]: true } : s.openFolders,
    }));
    toast.success(`已在 ${target || "根目录"} 创建《${title}》`);
  },

  createSubFolder(parent, name) {
    const n = name.trim();
    if (!n) return;
    get().createNoteIn(n, parent ? `${parent}/${n}` : n);
  },

  async renameFolder(folder, newName) {
    const name = newName.trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) {
      toast.error("名称不能包含 \\ / : * ? \" < > |");
      return;
    }
    const segs = folder.split("/");
    segs[segs.length - 1] = name;
    const renamed = segs.join("/");
    if (renamed === folder) return;
    const target = resolveFolder(folder);
    if (isTauri()) {
      // 同时加载的仓库顶层节点（rel 为空）= 仓库根目录本身，不允许在此改名
      if (!target || !target.rel) return;
      const slash = target.rel.lastIndexOf("/");
      const rel = `${slash >= 0 ? target.rel.slice(0, slash + 1) : ""}${name}`;
      try {
        await invoke("vault_rename_dir", { root: target.root, from: target.rel, to: rel });
      } catch (e) {
        toast.error("重命名失败", { description: String(e) });
        return;
      }
    }
    set((s) => {
      const notes = rewriteFolder(s.notes, folder, renamed);
      const idx = s.notes.findIndex((n) => n.id === s.activeId);
      const openFolders: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(s.openFolders)) {
        openFolders[k === folder || k.startsWith(`${folder}/`) ? `${renamed}${k.slice(folder.length)}` : k] = v;
      }
      return { notes, activeId: idx >= 0 ? notes[idx].id : s.activeId, openFolders };
    });
    toast.success(`文件夹已重命名为「${name}」`);
  },

  async deleteFolder(folder) {
    const target = resolveFolder(folder);
    if (isTauri()) {
      if (!target || !target.rel) return;
      try {
        await invoke("vault_delete_dir", { root: target.root, rel: target.rel });
      } catch (e) {
        toast.error("删除失败", { description: String(e) });
        return;
      }
    }
    set((s) => {
      const under = (f?: string) => f === folder || (f ?? "").startsWith(`${folder}/`);
      const notes = s.notes.filter((n) => !under(n.folder));
      return {
        notes,
        activeId: notes.some((n) => n.id === s.activeId) ? s.activeId : notes[0]?.id ?? null,
        openFolders: Object.fromEntries(Object.entries(s.openFolders).filter(([k]) => !under(k))),
      };
    });
    toast.success(`已删除文件夹「${folder}」`);
  },

  async revealFolder(folder) {
    const target = resolveFolder(folder);
    if (!target) return;
    await get().openFolderPath(target.rel ? `${target.root}/${target.rel}` : target.root);
  },

  async openFolderPath(path) {
    if (!isTauri()) return;
    try {
      const { openPath } = await import("@tauri-apps/plugin-opener");
      await openPath(path.replace(/\\/g, "/"));
    } catch (e) {
      toast.error("打开文件夹失败", { description: String(e) });
    }
  },

  async renameVault(root, newName) {
    const name = newName.trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) {
      toast.error("名称不能包含 \\ / : * ? \" < > |");
      return;
    }
    const isPrimary = root === primaryRoot;
    const isExtra = extraVaults.has(root);
    if (!isPrimary && !isExtra) return;
    const oldName = vaultNameOf(root);
    if (oldName === name) return;
    let next = root;
    if (isTauri()) {
      try {
        next = await invoke<string>("vault_rename_root", { root, newName: name });
      } catch (e) {
        toast.error("重命名仓库失败", { description: String(e) });
        return;
      }
    }
    // 注册表 / 已加载集合 / 主仓库键
    const list = loadRegistered().map((r) => (r === root ? next : r));
    saveRegistered(list);
    const loaded = get().loadedVaults.map((r) => (r === root ? next : r));
    if (isPrimary) {
      localStorage.setItem("pkmx.vault.root", next);
      primaryRoot = next;
      if (repo.kind === "fs") repo = new FsVault(next);
    }
    if (isExtra) {
      extraVaults.delete(root);
      extraVaults.set(next, name);
      fsVaultCache.delete(root);
    }
    const only = vaultOnly.get(root);
    if (only) {
      vaultOnly.delete(root);
      vaultOnly.set(next, only);
      saveExternalFiles();
    }
    if (watchedRoots.has(root)) {
      watchedRoots.delete(root);
      startWatcher(next);
    }
    set((s) => ({
      registeredVaults: list,
      loadedVaults: loaded,
      notes: s.notes.map((n) => {
        if (n.vaultRoot !== root) return n;
        if (!isExtra) return { ...n, vaultRoot: next };
        // 同时加载的仓库：显示路径与 id 都带仓库名前缀，整体改写
        const rel = n.rel ?? n.id;
        const inner = (n.folder ?? "").startsWith(`${oldName}/`)
          ? (n.folder ?? "").slice(oldName.length + 1)
          : "";
        return {
          ...n,
          vaultRoot: next,
          vaultName: name,
          rel,
          folder: inner ? `${name}/${inner}` : name,
          id: `${name}::${rel}`,
        };
      }),
      views: s.views.map((v) =>
        isExtra && v.id.startsWith(`views/${oldName}__`)
          ? { ...v, id: `views/${name}__${v.id.slice(`views/${oldName}__`.length)}` }
          : v,
      ),
    }));
    saveLoadedVaults(loaded);
    toast.success(`仓库已重命名为「${name}」`);
  },

  moveNote(id, folder) {
    const s = get();
    const note = s.notes.find((n) => n.id === id);
    if (!note) return;
    if (note.doc) {
      toast("办公文档暂不支持移动/重命名（可在资源管理器中操作）");
      return;
    }
    if (note.vaultRoot) {
      // 额外仓库：只允许在本仓库内移动（folder 显示为 仓库名/内部路径）
      const prefix = `${note.vaultName}/`;
      if (folder && !folder.startsWith(prefix)) {
        toast("同时加载的仓库暂不支持跨仓库移动");
        return;
      }
      const inner = folder ? folder.slice(prefix.length) : "";
      const newRel = inner ? `${inner}/${note.fileName}` : note.fileName;
      if (newRel === note.rel) return;
      if (s.notes.some((n) => n.id === `${note.vaultName}::${newRel}`)) {
        toast.error("目标位置已有同名文件");
        return;
      }
      const moved: Note = { ...note, id: `${note.vaultName}::${newRel}`, rel: newRel, folder };
      const v = getFsVault(note.vaultRoot!);
      v.write(newRel, serializeNote(noteMetaOf(moved), note.body))
        .then(() => v.delete(note.rel!))
        .catch((e) => toast.error("移动失败", { description: String(e) }));
      lastWritten.delete(id);
      set({
        notes: [...s.notes.filter((n) => n.id !== id), moved],
        activeId: s.activeId === id ? moved.id : s.activeId,
        openFolders: folder ? { ...s.openFolders, [folder]: true } : s.openFolders,
      });
      toast.success(`已移动到 ${folder || "仓库根目录"}`);
      return;
    }
    const newId = folder ? `${folder}/${note.fileName}` : note.fileName;
    if (s.notes.some((n) => n.id === newId)) {
      toast.error("目标位置已有同名文件");
      return;
    }
    const moved: Note = { ...note, id: newId, folder };
    repo
      .write(newId, serializeNote(noteMetaOf(moved), note.body))
      .then(() => repo.delete(id))
      .catch((e) => toast.error("移动失败", { description: String(e) }));
    lastWritten.delete(id);
    set({
      notes: [...s.notes.filter((n) => n.id !== id), moved],
      activeId: s.activeId === id ? newId : s.activeId,
      viewId: s.viewId,
      openFolders: folder ? { ...s.openFolders, [folder]: true } : s.openFolders,
    });
    toast.success(folder ? `已移动到 ${folder}/` : "已移动到根目录");
  },

  renameNote(id, newName) {
    const s = get();
    const note = s.notes.find((n) => n.id === id);
    if (!note) return;
    if (note.doc) {
      toast("办公文档暂不支持移动/重命名（可在资源管理器中操作）");
      return;
    }
    const fileName = newName.toLowerCase().endsWith(".md") ? newName : `${newName}.md`;
    if (fileName === note.fileName) return;
    if (note.vaultRoot) {
      const newRel = note.folder ? `${note.folder.slice(note.vaultName!.length + 1)}/${fileName}` : fileName;
      if (s.notes.some((n) => n.id === `${note.vaultName}::${newRel}`)) {
        toast.error("已有同名文件");
        return;
      }
      const moved: Note = { ...note, id: `${note.vaultName}::${newRel}`, rel: newRel, fileName };
      const v = getFsVault(note.vaultRoot);
      v.write(newRel, serializeNote(noteMetaOf(moved), note.body))
        .then(() => v.delete(note.rel!))
        .catch((e) => toast.error("重命名失败", { description: String(e) }));
      lastWritten.delete(id);
      set({
        notes: [...s.notes.filter((n) => n.id !== id), moved],
        activeId: s.activeId === id ? moved.id : s.activeId,
      });
      toast.success(`已重命名为 ${fileName}`);
      return;
    }
    const newId = note.folder ? `${note.folder}/${fileName}` : fileName;
    if (s.notes.some((n) => n.id === newId)) {
      toast.error("已有同名文件");
      return;
    }
    const moved: Note = { ...note, id: newId, fileName };
    repo
      .write(newId, serializeNote(noteMetaOf(moved), note.body))
      .then(() => repo.delete(id))
      .catch((e) => toast.error("重命名失败", { description: String(e) }));
    lastWritten.delete(id);
    set({
      notes: [...s.notes.filter((n) => n.id !== id), moved],
      activeId: s.activeId === id ? newId : s.activeId,
    });
    toast.success(`已重命名为 ${fileName}`);
  },

  deleteNote(id) {
    const s = get();
    const note = s.notes.find((n) => n.id === id);
    if (!note) return;
    const target = note.vaultRoot ? getFsVault(note.vaultRoot) : repo;
    target.delete(note.rel ?? id).catch((e) => toast.error("删除失败", { description: String(e) }));
    lastWritten.delete(id);
    const notes = s.notes.filter((n) => n.id !== id);
    set({
      notes,
      activeId: s.activeId === id ? (notes[0]?.id ?? null) : s.activeId,
    });
    toast.success(`已删除 ${note.fileName}`);
  },

  deleteView(id) {
    repo.delete(id).catch(() => undefined);
    set((s) => ({
      views: s.views.filter((v) => v.id !== id),
      view: s.viewId === id ? "board" : s.view,
      viewId: s.viewId === id ? null : s.viewId,
    }));
    toast.success("视图已删除");
  },

  toggleFolder(name) {
    set((s) => ({ openFolders: { ...s.openFolders, [name]: !s.openFolders[name] } }));
  },

  toggleTheme() {
    get().setTheme(themeKind(get().theme) === "dark" ? "daybreak" : "nightink");
  },

  setTheme(id) {
    applyTheme(id);
    localStorage.setItem("pkmx.theme", id);
    set({ theme: id });
  },

  setCaptureOpen(open, status = null) {
    set({ captureOpen: open, captureStatus: status });
  },
  setQuickOpenOpen(open) {
    set({ quickOpenOpen: open });
  },

  cycleEditMode() {
    set((s) => {
      const order: EditorMode[] = ["read", "block", "source"];
      const next = order[(order.indexOf(s.editMode) + 1) % order.length];
      localStorage.setItem("pkmx.editMode", next);
      return { editMode: next };
    });
  },

  setEditMode(mode) {
    localStorage.setItem("pkmx.editMode", mode);
    set({ editMode: mode });
  },

  toggleWide() {
    set((s) => ({ wide: !s.wide }));
  },

  /** 定位或创建当日笔记（笔记菜单 →「今日笔记」），返回其 id */
  ensureDaily() {
    const found = get().notes.find((n) => n.date === TODAY && !n.vaultRoot);
    if (found) return found.id;
    const id = `${TODAY}.md`;
    const note: Note = {
      id,
      folder: "",
      fileName: id,
      title: weekdayTitle(TODAY),
      body: "## 今日聚焦\n- [ ] \n\n## 记录\n",
      date: TODAY,
      created: TODAY,
    };
    persistNote(note);
    set((s) => ({ notes: [...s.notes, note] }));
    return id;
  },

  linkSelection(id, text) {
    const t = text.trim();
    if (!t || t.includes("]]") || t.includes("[[") || t.length > 80) {
      toast("选区不能包含 [[ ]] 或超过 80 字");
      return;
    }
    const note = get().notes.find((n) => n.id === id);
    if (!note) return;
    const idx = note.body.indexOf(text);
    if (idx < 0) return;
    const next = `${note.body.slice(0, idx)}[[${t}]]${note.body.slice(idx + text.length)}`;
    get().updateBody(id, next);
    toast.success(`已把「${t.slice(0, 24)}」转为双链；若是新名字，点击链接可创建笔记`);
  },

  openPrompt(title, opts) {
    return new Promise((resolve) => {
      promptCb = resolve;
      set({
        prompt: {
          open: true,
          title,
          label: opts?.label,
          value: opts?.value ?? "",
          placeholder: opts?.placeholder,
        },
      });
    });
  },

  answerPrompt(value) {
    promptCb(value);
    promptCb = () => {};
    set((s) => ({ prompt: { ...s.prompt, open: false } }));
  },

  openConfirm(title, message, opts) {
    return new Promise((resolve) => {
      confirmCb = resolve;
      set({ confirm: { open: true, title, message, okLabel: opts?.okLabel, danger: opts?.danger } });
    });
  },

  answerConfirm(ok) {
    confirmCb(ok);
    confirmCb = () => {};
    set((s) => ({ confirm: { ...s.confirm, open: false } }));
  },

  async writeAttachment(dataUrl, ext) {
    const rel = `attachments/paste-${Date.now()}.${ext}`;
    await repo.writeBin(rel, dataUrl);
    attachmentCache.set(rel, dataUrl);
    return rel;
  },

  async openPaths(paths) {
    if (!isTauri()) return;
    for (const p of paths) {
      // 按文件系统真实类型分流：文件交给 openExternalFile（自带扩展名校验），
      // 仅目录才作为仓库加载——否则拖入 docx 等文件会被当仓库根报 not a directory
      const isDir = await invoke<boolean>("path_is_dir", { path: p }).catch(() => false);
      if (isDir) {
        await get().addVault(p);
      } else {
        await get().openExternalFile(p);
      }
    }
  },

  async openExternalFile(path, silent = false) {
    if (!isTauri()) return;
    const norm = path.replace(/\\/g, "/");
    const cut = norm.lastIndexOf("/");
    const root = cut > 0 ? norm.slice(0, cut) : "";
    const rel = norm.slice(cut + 1);
    if (!root || !(/\.md$/i.test(rel) || isDocFile(rel))) {
      toast("只支持打开 Markdown、办公文档与文件夹");
      return;
    }
    const name = vaultNameOf(root);
    const id = root === primaryRoot ? rel : `${name}::${rel}`;
    const existing = get().notes.find((n) => n.id === id);
    if (existing) {
      get().openNote(id); // 已在树里：直接打开（openNote 会从磁盘刷新）
      return;
    }
    try {
      const note = isDocFile(rel)
        ? toDocNote(rel, root === primaryRoot ? undefined : { root, name })
        : toNote(rel, await invoke<string>("vault_read", { root, rel }), root === primaryRoot ? undefined : { root, name });
      if (root !== primaryRoot) {
        extraVaults.set(root, name);
        const only = vaultOnly.get(root) ?? new Set<string>();
        only.add(rel);
        vaultOnly.set(root, only);
        saveExternalFiles();
        startWatcher(root);
      }
      set((s) => ({
        notes: s.notes.some((n) => n.id === note.id) ? s.notes : [...s.notes, note],
        loadedVaults: s.loadedVaults.includes(root) ? s.loadedVaults : [...s.loadedVaults, root],
        view: "note",
        activeId: note.id,
        editMode: "read",
      }));
      if (!silent) toast.success(`已打开 ${note.fileName}（原地读写，不复制）`);
    } catch (e) {
      if (!silent) toast.error("打开文件失败", { description: String(e) });
    }
  },

  importTexts(entries) {
    if (!entries.length) return;
    let notes = [...get().notes];
    const added: Note[] = [];
    for (const { path, text } of entries) {
      const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
      const fileName = (parts.pop() ?? "未命名.md").replace(/\.md$/i, "") + ".md";
      const folder = parts.join("/");
      const rel = uniqueRelPath(notes, fileName, folder);
      const note = toNote(rel, text);
      repo.write(rel, text).catch((e) => toast.error(`导入失败：${fileName}`, { description: String(e) }));
      notes = [...notes, note];
      added.push(note);
    }
    set({ notes });
    toast.success(`已导入 ${added.length} 篇笔记`);
  },
}));

/* 上次视图/笔记持续记录：任何状态变更都同步到 localStorage，重启/热重载后由 restoreSessionView 恢复 */
let lastSession = "";
let initRan = false; // StrictMode 下 init 幂等护栏
useStore.subscribe((s) => {
  if (!s.ready || s.needsVault) return;
  const cur = JSON.stringify({
    view: s.view,
    viewId: s.viewId,
    activeId: s.activeId,
    activeIssueId: s.activeIssueId,
  });
  if (cur === lastSession) return;
  lastSession = cur;
  localStorage.setItem(SESSION_KEY, cur);
});

// 浏览器 dev 模式暴露 store，供自动化测试注入状态（正式构建被裁剪）
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__pkmxStore = useStore;
}

/** Rust 侧全文搜索（主仓库 + 同时加载的仓库）；浏览器/内存仓库返回 null 走前端过滤 */
export async function searchVaults(query: string): Promise<{ note: Note; snippet: string }[] | null> {
  if (!isTauri() || !primaryRoot) return null;
  const roots = [primaryRoot, ...extraVaults.keys()];
  const out: { note: Note; snippet: string }[] = [];
  for (const root of roots) {
    try {
      const hits = await invoke<{ rel: string; title: string; snippet: string }[]>("vault_search", {
        root,
        query,
        limit: 50,
      });
      const name = vaultNameOf(root);
      for (const h of hits) {
        const id = root === primaryRoot ? h.rel : `${name}::${h.rel}`;
        const note = useStore.getState().notes.find((n) => n.id === id);
        if (note) out.push({ note, snippet: h.snippet });
      }
    } catch {
      /* 单个仓库搜索失败跳过 */
    }
  }
  return out;
}
