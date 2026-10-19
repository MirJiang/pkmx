import { invoke } from "@tauri-apps/api/core";
import { isDocFile } from "./office";

export interface RawNoteFile {
  relPath: string;
  text: string;
}

export interface VaultRepo {
  kind: "memory" | "fs";
  rootName: string;
  loadAll(): Promise<RawNoteFile[]>;
  write(relPath: string, text: string): Promise<void>;
  delete(relPath: string): Promise<void>;
  /** dataURL 形式的二进制写入（附件） */
  writeBin(relPath: string, dataUrl: string): Promise<void>;
  /** 读取附件为 dataURL */
  readBin(relPath: string): Promise<string>;
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function b64ToDataUrl(b64: string, rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "png";
  const mime =
    ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "application/octet-stream";
  return `data:${mime};base64,${b64}`;
}

/** 内存仓库：浏览器开发用（无磁盘权限），内容只活在内存里，刷新即空 */
export class MemoryVault implements VaultRepo {
  kind = "memory" as const;
  rootName = "内存仓库";
  private files = new Map<string, string>();
  private bins = new Map<string, string>();

  async loadAll(): Promise<RawNoteFile[]> {
    return [...this.files.entries()].map(([relPath, text]) => ({ relPath, text }));
  }
  async write(relPath: string, text: string): Promise<void> {
    this.files.set(relPath, text);
  }
  async delete(relPath: string): Promise<void> {
    this.files.delete(relPath);
  }
  async writeBin(relPath: string, dataUrl: string): Promise<void> {
    this.bins.set(relPath, dataUrl);
  }
  async readBin(relPath: string): Promise<string> {
    const hit = this.bins.get(relPath);
    if (hit) return hit;
    throw new Error("附件不存在（内存仓库不含附件）");
  }
}

/** 真实文件系统仓库：走 Rust 命令，无 fs 插件 scope 负担 */
export class FsVault implements VaultRepo {
  kind = "fs" as const;
  rootName: string;

  constructor(public root: string) {
    this.rootName = root.split(/[\\/]/).filter(Boolean).pop() || "vault";
  }

  async loadAll(): Promise<RawNoteFile[]> {
    const rels: string[] = await invoke("vault_list", { root: this.root });
    const out: RawNoteFile[] = [];
    for (const relPath of rels) {
      if (isDocFile(relPath)) {
        out.push({ relPath, text: "" }); // 办公文档按需读二进制，不预读文本
        continue;
      }
      try {
        const text = await invoke<string>("vault_read", { root: this.root, rel: relPath });
        out.push({ relPath, text });
      } catch {
        // 单个文件读取失败不阻塞整个仓库
      }
    }
    return out;
  }

  async write(relPath: string, text: string): Promise<void> {
    await invoke("vault_write", { root: this.root, rel: relPath, content: text });
  }

  async delete(relPath: string): Promise<void> {
    await invoke("vault_delete", { root: this.root, rel: relPath });
  }

  async writeBin(relPath: string, dataUrl: string): Promise<void> {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    await invoke("vault_write_bin", { root: this.root, rel: relPath, b64 });
  }

  async readBin(relPath: string): Promise<string> {
    const b64 = await invoke<string>("vault_read_bin", { root: this.root, rel: relPath });
    return b64ToDataUrl(b64, relPath);
  }
}
