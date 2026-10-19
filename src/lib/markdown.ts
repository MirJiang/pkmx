/**
 * Markdown 渲染：markdown-it（CommonMark + GFM 表格/删除线）为内核，
 * 通过规则扩展承载 PKMX 的交互元素（输出 HTML 带 data-* 标记，由 Editor 事件委托）：
 *  - [[双链]]：inline 规则 → span.ink-wl（未解析带 unres，点击创建）
 *  - 任务勾选：core 规则把 `- [ ]` 首行改写为 .ink-task 结构，data-task 为全篇
 *    全局序号（块编辑按块渲染时以 taskStart 偏移对齐，勾选回写靠它定位）
 *  - 附件图片：仓库内相对路径不写 src，改挂 data-att 由 Editor 经 vault 解析
 * 其余（分块/任务行操作/纯文本标题提取）与渲染器无关，均为文本层逻辑。
 */
import MarkdownIt from "markdown-it";

interface InkEnv {
  titles: Set<string>;
  taskIdx: number;
}

type Md = InstanceType<typeof MarkdownIt>;
const md: Md = new MarkdownIt({ html: false, breaks: false, linkify: false, typographer: false });
const esc = md.utils.escapeHtml.bind(md.utils);

/* ---- [[双链]]：在 link 规则之前拦截，避免与 []() 语法纠缠 ---- */
md.inline.ruler.before("link", "ink-wikilink", (state, silent) => {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const name = src.slice(pos + 2, end).trim();
  if (!name || name.includes("[")) return false;
  if (!silent) {
    const t = state.push("ink-wikilink", "", 0);
    t.content = name;
  }
  state.pos = end + 2;
  return true;
});
md.renderer.rules["ink-wikilink"] = (tokens, idx, _opts, env) => {
  const name = tokens[idx].content;
  const hit = (env as unknown as InkEnv).titles.has(name);
  return `<span class="ink-wl${hit ? "" : " unres"}" data-wikilink="${esc(name)}" title="${hit ? "" : "未解析 · 点击创建"}">${esc(name)}</span>`;
};

/* ---- 任务勾选：改写列表项首行，注入 .ink-task 结构（保持全篇全局序号） ---- */
md.core.ruler.after("inline", "ink-tasks", (state) => {
  const env = state.env as unknown as InkEnv;
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i];
    if (t.type !== "inline" || !t.children?.length) continue;
    // 仅列表项的第一个段落（list_item_open > paragraph_open > inline）
    if (state.tokens[i - 1]?.type !== "paragraph_open") continue;
    if (state.tokens[i - 2]?.type !== "list_item_open") continue;
    const first = t.children[0];
    if (first.type !== "text") continue;
    const m = first.content.match(/^\[([ x])\]\s+(.*)$/);
    if (!m) continue;
    const idx = env.taskIdx++;
    let text = m[2];
    let meta = "";
    const dueM = text.match(/@due\(([^)]+)\)/);
    if (dueM) {
      meta = `<span class="meta">@due(${esc(dueM[1])})</span>`;
      text = text.replace(/@due\([^)]+\)/, "").trim();
    }
    first.content = text;
    const open = new state.Token("html_inline", "", 0);
    open.content = `<div class="ink-task"><input type="checkbox" data-task="${idx}"${m[1] === "x" ? " checked" : ""} aria-label="任务" /><span class="tl">`;
    const close = new state.Token("html_inline", "", 0);
    close.content = `</span>${meta}<button class="ink-to-task" data-to-task="${idx}" title="转为任务笔记">＋任务</button></div>`;
    t.children = [open, ...t.children, close];
  }
});

/* ---- 附件图片：仓库内相对路径 → data-att（Editor 经 vault 解析后补 src） ---- */
const defaultImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
  const tok = tokens[idx];
  const src = String(tok.attrGet("src") ?? "");
  if (src && !/^(https?:|data:)/.test(src)) {
    tok.attrs = (tok.attrs ?? []).filter(([k]) => k !== "src");
    tok.attrSet("data-att", src);
  }
  tok.attrJoin("class", "ink-img");
  return defaultImage(tokens, idx, opts, env, self);
};

export function renderMarkdown(body: string, noteTitles: Set<string>, taskStart = 0): string {
  return md.render(body, { titles: noteTitles, taskIdx: taskStart } satisfies InkEnv);
}

export function renderInline(s: string, noteTitles: Set<string>): string {
  return md.renderInline(s, { titles: noteTitles, taskIdx: 0 } satisfies InkEnv);
}

/** 统计一段文本里勾选项的数量（块编辑求 data-task 偏移用） */
export function countTasks(text: string): number {
  return (text.match(/^- \[[ x]\]/gm) ?? []).length;
}

/** 把正文切成块（段落/标题/列表/代码块/引用/表格各为一块），记录行区间用于精确回写 */
export interface MdBlock {
  start: number; // 起始行（含）
  end: number; // 结束行（不含）
  raw: string;
}

const BLOCK_START = /^(#{1,6}\s|```|> |- \[[ x]\]|- |\d+\. |\||(-{3,}|\*{3,})$)/;

export function splitBlocks(body: string): MdBlock[] {
  const lines = body.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i++;
      continue;
    }
    let j = i + 1;
    if (lines[i].startsWith("```")) {
      while (j < lines.length && !lines[j].startsWith("```")) j++;
      j = Math.min(j + 1, lines.length); // 含收尾 ```
    } else if (/^>/.test(lines[i])) {
      while (j < lines.length && /^>/.test(lines[j])) j++;
    } else if (/^(- \[[ x]\]|- |\d+\. )/.test(lines[i])) {
      const re = /^(- \[[ x]\]|- |\d+\. )/;
      while (j < lines.length && re.test(lines[j])) j++;
    } else if (/^\|/.test(lines[i])) {
      while (j < lines.length && /^\|/.test(lines[j].trim())) j++;
    } else if (!BLOCK_START.test(lines[i])) {
      // 段落：延续到空行或任意块起点
      while (j < lines.length && lines[j].trim() !== "" && !BLOCK_START.test(lines[j])) j++;
    }
    blocks.push({ start: i, end: j, raw: lines.slice(i, j).join("\n") });
    i = j;
  }
  return blocks;
}

/** 块编辑提交：以块为单位重组正文（空块剔除，块间统一一个空行，保留前导空行） */
export function joinBlocks(body: string, edited: Map<number, string>): string {
  const lines = body.split("\n");
  const blocks = splitBlocks(body);
  const out: string[] = [];
  const first = blocks[0]?.start ?? lines.length;
  out.push(...lines.slice(0, first)); // 正文前导空行（通常没有）
  let pushed = false;
  for (const b of blocks) {
    const raw = edited.get(b.start) ?? b.raw;
    if (raw.trim() === "") continue;
    if (pushed) out.push("");
    out.push(...raw.split("\n"));
    pushed = true;
  }
  let text = out.join("\n"); // 块间分隔在拼接时已统一为一个空行，不做全局归一以免破坏代码块内空行
  if (!text.endsWith("\n")) text += "\n";
  return text;
}

/** 切换正文中第 idx 个 checkbox 的勾选状态 */
export function toggleTaskInBody(body: string, idx: number): string {  const re = /- \[([ x])\]/g;
  let n = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    n++;
    if (n === idx) break;
  }
  if (n !== idx || !m) return body;
  const flip = m[1] === "x" ? " " : "x";
  return body.slice(0, m.index) + `- [${flip}]` + body.slice(m.index + 5);
}

/** 取第 idx 个任务的原始行文本（去掉 checkbox 语法与 @due，保留内联标记） */
export function taskLineAt(body: string, idx: number): { text: string; due?: string } | null {
  const re = /- \[([ x])\]\s+(.*)/g;
  let n = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    n++;
    if (n === idx) {
      let text = m[2];
      const dueM = text.match(/@due\(([^)]+)\)/);
      if (dueM) text = text.replace(/@due\([^)]+\)/, "").trim();
      return { text, due: dueM?.[1] };
    }
  }
  return null;
}

/** 删除第 idx 个任务行 */
export function removeTaskLine(body: string, idx: number): string {
  const lines = body.split("\n");
  let n = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[[ x]\]/.test(lines[i])) {
      n++;
      if (n === idx) {
        lines.splice(i, 1);
        return lines.join("\n");
      }
    }
  }
  return body;
}

/** 去掉内联标记得到纯文本标题（用于生成任务笔记标题） */
export function plainTitle(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim()
    .slice(0, 80);
}
