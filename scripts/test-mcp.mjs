/**
 * tantivy 索引端到端测试：经 MCP stdio 实测（node scripts/test-mcp.mjs <exe路径>）
 * 覆盖：中英文搜索排序、多词 AND、标题命中、外部增/改/删的增量同步、
 *       单字符回退扫描、update_note mtime 守卫回归。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, unlinkSync } from "node:fs";
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
const good = await call("tools/call", {
  name: "update_note",
  arguments: { rel: "量化策略.md", content: note.content, expected_mtime: note.mtime },
});
assert(good.result.isError !== true, "正确 mtime 通过");

child.kill();
rmSync(vault, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
