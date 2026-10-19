/**
 * tantivy 索引端到端测试：经 MCP stdio 实测（node scripts/test-mcp.mjs <exe路径>）
 * 覆盖：中英文搜索排序、多词 AND、标题命中、外部增/改/删的增量同步、
 *       单字符回退扫描、毫秒级 mtime 守卫、缺失文件友好错误、delete_note。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const exe = process.argv[2] ?? "src-tauri/target/release/pkmx.exe";
const vault = mkdtempSync(join(tmpdir(), "pkmx-mcp-test-"));
mkdirSync(join(vault, "开发"));

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

writeFileSync(join(vault, "量化策略.md"), `---\nstatus: Doing\n---\n\n# 量化策略笔记\n\n量化的回测设计，包含 router 转发与风控。\n`);
writeFileSync(join(vault, "开发/框架设计.md"), `# 框架设计\n\n这是一个设计文档，提到框架的总体结构。\n`);
writeFileSync(join(vault, "无关笔记.md"), `# 无关笔记\n\n今天天气不错，出去走了走。\n`);

const child = spawn(exe, ["--mcp", "--vault", vault], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    /* 非 JSON 行忽略 */
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function search(query, limit = 20) {
  const r = await call("tools/call", { name: "search_notes", arguments: { query, limit } });
  if (r.error) throw new Error(r.error.message);
  return JSON.parse(r.result.content[0].text);
}

const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
assert(init.result?.serverInfo?.name === "pkmx-mcp", "initialize 成功");

console.log("== 中文关键词 ==");
let r = await search("量化");
assert(r.count === 1 && r.notes[0].rel === "量化策略.md", `“量化”只命中量化策略笔记（实际 ${JSON.stringify(r.notes.map((n) => n.rel))}）`);
assert(r.notes[0].snippet.includes("量化"), "返回命中片段");

r = await search("设计");
assert(r.count === 2, `“设计”命中 2 篇（实际 ${r.count}）`);
assert(r.notes[0].rel === "开发/框架设计.md", "BM25 排序：标题命中与词频更高的在前");

console.log("== 多词 AND / 英文 ==");
r = await search("量化 风控");
assert(r.count === 1 && r.notes[0].rel === "量化策略.md", "多词 AND 语义");
r = await search("ROUTER");
assert(r.count === 1, "英文大小写不敏感");
r = await search("不存在的词xyz");
assert(r.count === 0, "无命中返回空");

console.log("== 增量同步（外部增/改/删） ==");
writeFileSync(join(vault, "新文件.md"), "# 新文件\n\n这里有增量验证词。\n");
r = await search("增量验证词");
assert(r.count === 1 && r.notes[0].rel === "新文件.md", "外部新建文件即时可搜");

writeFileSync(join(vault, "无关笔记.md"), "# 无关笔记\n\n补一句：下午喝了咖啡。\n");
utimesSync(join(vault, "无关笔记.md"), new Date(), new Date()); // 确保 mtime 变化
r = await search("咖啡");
assert(r.count === 1, "外部修改后新内容可搜（mtime 增量）");

unlinkSync(join(vault, "新文件.md"));
r = await search("增量验证词");
assert(r.count === 0, "外部删除后不再可搜");

console.log("== 单字符回退扫描 ==");
r = await search("设");
assert(
  r.count === 2 && r.notes.some((n) => n.rel === "开发/框架设计.md") && r.notes.some((n) => n.rel === "量化策略.md"),
  "单字符查询回退实时扫描仍可用（命中两篇含“设”的笔记）",
);

console.log("== update_note mtime 守卫（回归） ==");
const got = await call("tools/call", { name: "get_note", arguments: { rel: "量化策略.md" } });
const note = JSON.parse(got.result.content[0].text);
const bad = await call("tools/call", {
  name: "update_note",
  arguments: { rel: "量化策略.md", content: "x", expected_mtime: note.mtime - 9999 },
});
assert(bad.result.isError === true, "过期 mtime 被拒绝");
assert(note.mtime > 1_500_000_000_000, "mtime 为 unix 毫秒精度");
const good = await call("tools/call", {
  name: "update_note",
  arguments: { rel: "量化策略.md", content: note.content, expected_mtime: note.mtime },
});
assert(good.result.isError !== true, "正确 mtime 通过");
await new Promise((r) => setTimeout(r, 20));
const stale = await call("tools/call", {
  name: "update_note",
  arguments: { rel: "量化策略.md", content: note.content, expected_mtime: note.mtime },
});
assert(stale.result.isError === true, "同秒内再次修改时旧 mtime 被拒绝（毫秒精度）");

const callTool = (name, args) => call("tools/call", { name, arguments: args });

console.log("== 缺失文件友好错误 ==");
let missing = await callTool("get_note", { rel: "不存在.md" });
assert(missing.result.isError === true && missing.result.content[0].text.includes("笔记不存在"), "get_note 缺失返回“笔记不存在”");
assert(missing.result.content[0].text.includes("search_notes"), "错误信息给出 search_notes 提示");
missing = await callTool("update_note", { rel: "缺失.md", content: "x" });
assert(missing.result.isError === true && missing.result.content[0].text.includes("笔记不存在"), "update_note 缺失返回“笔记不存在”");
assert(!existsSync(join(vault, "缺失.md")), "update_note 不会隐式创建缺失文件");
missing = await callTool("append_to_note", { rel: "缺失.md", content: "x" });
assert(missing.result.isError === true && missing.result.content[0].text.includes("笔记不存在"), "append_to_note 缺失返回“笔记不存在”");
missing = await callTool("delete_note", { rel: "缺失.md" });
assert(missing.result.isError === true && missing.result.content[0].text.includes("笔记不存在"), "delete_note 缺失返回“笔记不存在”");

console.log("== delete_note ==");
writeFileSync(join(vault, "待删除.md"), "# 待删除\n\n临时内容。\n");
const delNote = JSON.parse((await callTool("get_note", { rel: "待删除.md" })).result.content[0].text);
let del = await callTool("delete_note", { rel: "待删除.md", expected_mtime: delNote.mtime - 1 });
assert(del.result.isError === true && del.result.content[0].text.includes("mtime 不匹配"), "错误 mtime 阻止删除");
assert(existsSync(join(vault, "待删除.md")), "守卫失败时文件仍在");
del = await callTool("delete_note", { rel: "待删除.md", expected_mtime: delNote.mtime });
assert(del.result.isError !== true, "正确 mtime 删除成功");
assert(!existsSync(join(vault, "待删除.md")), "文件已从磁盘删除");
r = await search("待删除");
assert(r.count === 0, "删除后搜索不再命中");
r = await callTool("get_note", { rel: "待删除.md" });
assert(r.result.isError === true && r.result.content[0].text.includes("笔记不存在"), "删除后 get_note 返回友好错误");
r = await callTool("delete_note", { rel: "views/x.yml" });
assert(r.result.isError === true && r.result.content[0].text.includes("视图工具"), "delete_note 拒绝视图路径");

child.kill();
rmSync(vault, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
