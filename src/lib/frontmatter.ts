/**
 * frontmatter 解析/序列化。只支持扁平标量键——本产品的元数据模型就这么简单。
 * 这是有意的约束：文件在任何编辑器里都保持可读。
 */
export interface NoteMeta {
  status?: string;
  priority?: string;
  due?: string;
  done?: string;
  date?: string;
  created?: string;
}

const META_KEYS: (keyof NoteMeta)[] = ["status", "priority", "due", "done", "date", "created"];

export function parseNote(text: string): { meta: NoteMeta; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: NoteMeta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv && kv[2].trim()) {
      meta[kv[1] as keyof NoteMeta] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

export function serializeNote(meta: NoteMeta, body: string): string {
  const lines = META_KEYS.filter((k) => meta[k]).map((k) => `${k}: ${meta[k]}`);
  if (!lines.length) return body;
  return `---\n${lines.join("\n")}\n---\n` + body;
}
