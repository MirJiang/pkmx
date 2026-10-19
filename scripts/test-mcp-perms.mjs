/**
 * MCP 写入权限端到端测试：node scripts/test-mcp-perms.mjs <exe路径>
 * 覆盖：笔记工具禁用拒绝（含 delete_note / create_task）、视图工具独立权限（读/写）、
 *       笔记与视图路径隔离、create_task 默认文档目录与 frontmatter、视图 CRUD
 *       （含枚举校验、mtime 守卫、过滤条件全量替换）、run_view 执行语义（status/priority/
 *       due=today|week|overdue/text/limit）、tools/list ⚠ 标注、热生效。
 * 直接操作 %APPDATA%/pkmx/mcp.json 与 settings.json（与 GUI 设置等价），
 * 测试结束恢复原文件。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const exe = process.argv[2] ?? "src-tauri/target/release/pkmx.exe";
const isWin = process.platform === "win32";
const configDir = isWin
  ? join(process.env.APPDATA, "pkmx")
  : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pkmx");
const permsPath = join(configDir, "mcp.json");
const settingsPath = join(configDir, "settings.json");

const backup = existsSync(permsPath) ? readFileSync(permsPath, "utf8") : null;
const settingsBackup = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
const setPerms = (p) => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(permsPath, JSON.stringify(p, null, 2));
};
const setSettings = (s) => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(s, null, 2));
};

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const vault = mkdtempSync(join(tmpdir(), "pkmx-perms-test-"));
writeFileSync(join(vault, "笔记.md"), "# 笔记\n\n初始内容。\n");

/** 本地时区 YYYY-MM-DD，offset 为相对今天的天数 */
const localDate = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

setPerms({ create: false, update: false, append: true, delete: false, view_read: false, view_write: false });
setSettings({ default_folder: "任务" });

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

async function tool(name, args = {}) {
  const r = await call("tools/call", { name, arguments: args });
  if (r.error) throw new Error(r.error.message);
  return { isError: r.result.isError === true, text: r.result.content[0].text };
}

try {
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert(init.result?.serverInfo?.name === "pkmx-mcp", "initialize 成功");

  console.log("== tools/list 标注 ==");
  const list = await call("tools/list", {});
  const tools = Object.fromEntries(list.result.tools.map((t) => [t.name, t.description]));
  assert(tools["get_note"] !== undefined, "get_note 仍在工具列表");
  assert(tools["create_note"].includes("⚠"), "create_note 描述带 ⚠ 标注");
  assert(tools["create_task"].includes("⚠"), "create_task 描述带 ⚠ 标注");
  assert(tools["update_note"].includes("⚠"), "update_note 描述带 ⚠ 标注");
  assert(!tools["append_to_note"].includes("⚠"), "append_to_note 未被标注");
  assert(tools["delete_note"].includes("⚠"), "delete_note 描述带 ⚠ 标注");
  assert(tools["list_views"].includes("⚠"), "list_views 带 ⚠（view_read 关）");
  assert(tools["get_view"].includes("⚠"), "get_view 带 ⚠（view_read 关）");
  assert(tools["run_view"].includes("⚠"), "run_view 带 ⚠（view_read 关）");
  assert(tools["create_view"].includes("⚠"), "create_view 带 ⚠（view_write 关）");
  assert(
    ["list_views", "get_view", "run_view", "create_view", "update_view", "delete_view"].every((n) => tools[n] !== undefined),
    "六个视图工具都在列表",
  );

  console.log("== 禁用拒绝 ==");
  let r = await tool("create_note", { rel: "新笔记.md", content: "# 新\n" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("create_note"), "create_note 被拒绝");
  r = await tool("create_task", { title: "被拒绝的任务" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("create_task"), "create_task 被拒绝");
  r = await tool("update_note", { rel: "笔记.md", content: "# 改\n" });
  assert(r.isError && r.text.includes("权限拒绝"), "update_note 被拒绝");
  r = await tool("delete_note", { rel: "笔记.md" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("delete_note"), "delete_note 被拒绝");
  r = await tool("list_views", {});
  assert(r.isError && r.text.includes("list_views"), "list_views 被拒绝（view_read 关）");
  r = await tool("get_view", { rel: "views/x.yml" });
  assert(r.isError && r.text.includes("get_view"), "get_view 被拒绝（view_read 关）");
  r = await tool("run_view", { rel: "views/x.yml" });
  assert(r.isError && r.text.includes("run_view"), "run_view 被拒绝（view_read 关）");
  r = await tool("create_view", { name: "x" });
  assert(r.isError && r.text.includes("create_view"), "create_view 被拒绝（view_write 关）");

  console.log("== 笔记与视图路径隔离 ==");
  r = await tool("get_note", { rel: "views/x.yml" });
  assert(r.isError && r.text.includes("视图工具"), "get_note 拒绝视图路径并提示用视图工具");
  r = await tool("append_to_note", { rel: "views/x.yml", content: "x" });
  assert(r.isError && r.text.includes("视图工具"), "append_to_note（未禁用）也拒绝视图路径");

  console.log("== 放行路径 ==");
  r = await tool("append_to_note", { rel: "笔记.md", content: "追加一行" });
  assert(!r.isError, "append_to_note（未禁用）正常执行");
  r = await tool("get_note", { rel: "笔记.md" });
  assert(!r.isError && r.text.includes("追加一行"), "get_note 读到追加内容，只读工具不受影响");
  r = await tool("search_notes", { query: "初始" });
  assert(!r.isError, "search_notes 正常");

  console.log("== 热生效（同进程改配置） ==");
  setPerms({ create: true, update: true, append: true, delete: true, view_read: true, view_write: true });
  r = await tool("create_note", { rel: "新笔记.md", content: "# 新\n" });
  assert(!r.isError, "改配置后 create_note 立即恢复（无需重启）");
  r = await tool("update_note", { rel: "笔记.md", content: "# 覆写\n" });
  assert(!r.isError, "update_note 恢复");
  r = await tool("delete_note", { rel: "新笔记.md" });
  assert(!r.isError, "delete_note 恢复");
  r = await tool("get_note", { rel: "新笔记.md" });
  assert(r.isError && r.text.includes("笔记不存在"), "删除后 get_note 返回友好错误");

  console.log("== create_task 默认文档目录 ==");
  r = await tool("create_task", { title: "修复登录", due: "2026-12-31", body: "复现步骤见下。" });
  assert(!r.isError, "create_task 成功");
  const task = JSON.parse(r.text);
  assert(task.rel === "任务/修复登录.md", `写入默认文档目录（实际 ${task.rel}）`);
  assert(task.folder === "任务" && task.status === "Todo" && task.priority === "Normal", "返回默认目录/状态/优先级");
  r = await tool("get_note", { rel: "任务/修复登录.md" });
  assert(
    r.text.includes("status: Todo") &&
      r.text.includes("priority: Normal") &&
      r.text.includes("due: 2026-12-31") &&
      r.text.includes("# 修复登录") &&
      r.text.includes("复现步骤见下。"),
    "frontmatter、标题与正文正确",
  );
  r = await tool("create_task", { title: "修复登录" });
  assert(!r.isError && JSON.parse(r.text).rel === "任务/修复登录-2.md", "同名任务自动加 -2 后缀");
  r = await tool("create_task", { title: "设计评审", status: "Doing", priority: "High" });
  assert(!r.isError && JSON.parse(r.text).rel === "任务/设计评审.md", "自定义状态/优先级");
  r = await tool("create_task", { title: "坏状态", status: "InProgress" });
  assert(r.isError && r.text.includes("status"), "非法 status 被拒");
  r = await tool("create_task", { title: "坏日期", due: "2026-02-31" });
  assert(r.isError && r.text.includes("due"), "非法 due 被拒");
  setSettings({ default_folder: "其他" });
  r = await tool("create_task", { title: "换目录" });
  assert(!r.isError && JSON.parse(r.text).rel === "其他/换目录.md", "默认目录改动热生效");
  setSettings({});
  r = await tool("create_task", { title: "根目录任务" });
  assert(!r.isError && JSON.parse(r.text).rel === "根目录任务.md", "未设置默认目录时写入仓库根目录");

  console.log("== 视图 CRUD ==");
  r = await tool("create_view", { name: "测试视图", status: "Doing, Blocked", due: "week" });
  assert(!r.isError, "create_view 成功");
  r = await tool("create_view", { name: "测试视图" });
  assert(r.isError && r.text.includes("已存在"), "重复创建被拒");
  r = await tool("create_view", { name: "坏视图", due: "tomorrow" });
  assert(r.isError && r.text.includes("due"), "非法 due 值被拒");
  r = await tool("create_view", { name: "坏状态视图", status: "Doing, InProgress" });
  assert(r.isError && r.text.includes("status") && r.text.includes("InProgress"), "create_view 拒绝非法 status 枚举值");
  r = await tool("create_view", { name: "坏优先级视图", priority: "Critical" });
  assert(r.isError && r.text.includes("priority") && r.text.includes("Critical"), "create_view 拒绝非法 priority 枚举值");
  r = await tool("create_view", { name: "空状态视图", status: " , " });
  assert(r.isError && r.text.includes("status"), "create_view 拒绝空 status 列表");
  r = await tool("get_view", { rel: "views/测试视图.yml" });
  assert(!r.isError, "get_view 成功");
  const gv = JSON.parse(r.text);
  assert(gv.name === "测试视图" && gv.filters.status === "Doing, Blocked" && gv.filters.due === "week", `get_view 解析过滤条件（实际 ${r.text.slice(0, 120)}）`);
  r = await tool("update_view", { rel: "views/测试视图.yml", status: "Doing, NA", expected_mtime: gv.mtime });
  assert(r.isError && r.text.includes("status") && r.text.includes("NA"), "update_view 拒绝非法 status 枚举值");
  r = await tool("update_view", { rel: "views/测试视图.yml", name: "改名视图", text: "设计", expected_mtime: gv.mtime });
  assert(!r.isError, "update_view 成功（带 mtime 守卫）");
  r = await tool("get_view", { rel: "views/测试视图.yml" });
  assert(!r.isError && JSON.parse(r.text).name === "改名视图", "改名后 get_view 用原 rel 仍可读");
  r = await tool("get_view", { rel: "views/测试视图.yml" });
  const gv2 = JSON.parse(r.text);
  assert(gv2.filters.text === "设计" && gv2.filters.status === undefined, "update_view 全量替换过滤条件（旧键移除）");
  r = await tool("update_view", { rel: "views/测试视图.yml", name: "冲突", expected_mtime: 1 });
  assert(r.isError && r.text.includes("mtime 不匹配"), "视图 mtime 守卫生效");
  r = await tool("list_views", {});
  assert(!r.isError && JSON.parse(r.text).views.some((v) => v.name === "改名视图"), "list_views 含新视图");
  r = await tool("delete_view", { rel: "views/测试视图.yml" });
  assert(!r.isError, "delete_view 成功");
  r = await tool("get_view", { rel: "views/测试视图.yml" });
  assert(r.isError && r.text.includes("视图不存在"), "删除后 get_view 返回友好错误");
  r = await tool("get_view", { rel: "普通笔记.md" });
  assert(r.isError && r.text.includes("views/"), "视图工具拒绝非视图路径");

  console.log("== run_view 执行视图 ==");
  const today = localDate(0);
  const yesterday = localDate(-1);
  const farFuture = localDate(30);
  r = await tool("create_task", { title: "视图今天", status: "Doing", priority: "Urgent", due: today });
  assert(!r.isError, "创建今日任务");
  r = await tool("create_task", { title: "视图逾期", status: "Todo", priority: "High", due: yesterday });
  assert(!r.isError, "创建逾期任务");
  r = await tool("create_task", { title: "视图远期", status: "Blocked", priority: "Low", due: farFuture });
  assert(!r.isError, "创建远期任务");

  r = await tool("create_view", { name: "执行-今天", text: "视图", due: "today" });
  assert(!r.isError, "创建 due=today 视图");
  r = await tool("run_view", { rel: "views/执行-今天.yml" });
  let rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.tasks[0].title === "视图今天", "run_view due=today 精确匹配");
  assert(
    rv.tasks[0].status === "Doing" && rv.tasks[0].priority === "Urgent" && rv.tasks[0].due === today && rv.tasks[0].rel === "视图今天.md",
    "run_view 返回任务元数据",
  );

  r = await tool("create_view", { name: "执行-逾期", text: "视图", due: "overdue" });
  r = await tool("run_view", { rel: "views/执行-逾期.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.tasks[0].title === "视图逾期", "run_view due=overdue 只含过期任务");

  r = await tool("create_view", { name: "执行-状态", text: "视图", status: "Doing, Blocked" });
  r = await tool("run_view", { rel: "views/执行-状态.yml" });
  rv = JSON.parse(r.text);
  assert(
    rv.count === 2 && rv.tasks.some((t) => t.title === "视图今天") && rv.tasks.some((t) => t.title === "视图远期"),
    "run_view status 逗号多值匹配",
  );
  r = await tool("run_view", { rel: "views/执行-状态.yml", limit: 1 });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.tasks.length === 1, "run_view limit 生效");

  r = await tool("create_view", { name: "执行-优先级", text: "视图", priority: "Urgent" });
  r = await tool("run_view", { rel: "views/执行-优先级.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.tasks[0].title === "视图今天", "run_view priority 精确匹配");

  r = await tool("create_view", { name: "执行-本周", text: "视图", due: "week" });
  r = await tool("run_view", { rel: "views/执行-本周.yml" });
  rv = JSON.parse(r.text);
  assert(
    rv.tasks.some((t) => t.title === "视图今天") && !rv.tasks.some((t) => t.title === "视图远期"),
    "run_view due=week 含今天、排除 30 天后",
  );

  r = await tool("create_view", { name: "执行-文本", text: "逾期" });
  r = await tool("run_view", { rel: "views/执行-文本.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.tasks[0].title === "视图逾期", "run_view text 匹配标题");

  r = await tool("run_view", { rel: "views/不存在.yml" });
  assert(r.isError && r.text.includes("视图不存在"), "run_view 对缺失视图返回友好错误");
  r = await tool("run_view", { rel: "普通笔记.md" });
  assert(r.isError && r.text.includes("views/"), "run_view 拒绝非视图路径");
} finally {
  child.kill();
  if (backup !== null) writeFileSync(permsPath, backup);
  else if (existsSync(permsPath)) rmSync(permsPath);
  if (settingsBackup !== null) writeFileSync(settingsPath, settingsBackup);
  else if (existsSync(settingsPath)) rmSync(settingsPath);
  rmSync(vault, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
