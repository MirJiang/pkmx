/**
 * MCP 权限与 Issue 端到端测试：node scripts/test-mcp-perms.mjs <exe路径>
 * 覆盖：笔记/Issue/视图三组权限独立开关与热生效、旧任务迁移、Issue CRUD、
 *       独立 JSON 存储与笔记目录隔离、枚举/mtime 守卫、视图 CRUD、run_view 执行语义。
 * 直接操作 %APPDATA%/pkmx/mcp.json（与 GUI 设置等价），测试结束恢复原文件。
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

const backup = existsSync(permsPath) ? readFileSync(permsPath, "utf8") : null;
const setPerms = (p) => {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(permsPath, JSON.stringify(p, null, 2));
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
writeFileSync(
  join(vault, "旧任务.md"),
  `---\nstatus: Doing\npriority: High\ndue: 2026-12-31\ncreated: 2026-01-02\n---\n\n# 旧任务标题\n\n迁移前正文。\n`,
);

/** 本地时区 YYYY-MM-DD，offset 为相对今天的天数 */
const localDate = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const ALL_OFF = {
  create: false,
  update: false,
  append: true,
  delete: false,
  issue_read: false,
  issue_write: false,
  view_read: false,
  view_write: false,
};
const ALL_ON = {
  create: true,
  update: true,
  append: true,
  delete: true,
  issue_read: true,
  issue_write: true,
  view_read: true,
  view_write: true,
};
setPerms(ALL_OFF);

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
  assert(Object.keys(tools).length === 18, `共 18 个工具（实际 ${Object.keys(tools).length}）`);
  assert(tools["get_note"] !== undefined, "get_note 仍在工具列表");
  assert(tools["create_note"].includes("⚠"), "create_note 描述带 ⚠ 标注");
  assert(tools["create_task"].includes("⚠"), "create_task 描述带 ⚠ 标注");
  assert(tools["update_note"].includes("⚠"), "update_note 描述带 ⚠ 标注");
  assert(!tools["append_to_note"].includes("⚠"), "append_to_note 未被标注");
  assert(tools["delete_note"].includes("⚠"), "delete_note 描述带 ⚠ 标注");
  assert(tools["list_issues"].includes("⚠"), "list_issues 带 ⚠（issue_read 关）");
  assert(tools["get_issue"].includes("⚠"), "get_issue 带 ⚠（issue_read 关）");
  assert(tools["create_issue"].includes("⚠"), "create_issue 带 ⚠（issue_write 关）");
  assert(tools["update_issue"].includes("⚠"), "update_issue 带 ⚠（issue_write 关）");
  assert(tools["delete_issue"].includes("⚠"), "delete_issue 带 ⚠（issue_write 关）");
  assert(tools["list_views"].includes("⚠"), "list_views 带 ⚠（view_read 关）");
  assert(tools["run_view"].includes("⚠"), "run_view 带 ⚠（view_read 关）");
  assert(tools["create_view"].includes("⚠"), "create_view 带 ⚠（view_write 关）");
  assert(
    ["list_issues", "get_issue", "create_issue", "update_issue", "delete_issue"].every((n) => tools[n] !== undefined),
    "五个 Issue 工具都在列表",
  );
  assert(
    ["list_views", "get_view", "run_view", "create_view", "update_view", "delete_view"].every((n) => tools[n] !== undefined),
    "六个视图工具都在列表",
  );

  console.log("== 禁用拒绝 ==");
  let r = await tool("create_note", { rel: "新笔记.md", content: "# 新\n" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("create_note"), "create_note 被拒绝");
  r = await tool("create_task", { title: "被拒绝的任务" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("create_task"), "create_task 被拒绝");
  r = await tool("create_issue", { title: "被拒绝的 Issue" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("create_issue"), "create_issue 被拒绝");
  r = await tool("list_issues", {});
  assert(r.isError && r.text.includes("list_issues"), "list_issues 被拒绝（issue_read 关）");
  r = await tool("get_issue", { id: "iss_x" });
  assert(r.isError && r.text.includes("get_issue"), "get_issue 被拒绝（issue_read 关）");
  r = await tool("update_issue", { id: "iss_x", title: "x" });
  assert(r.isError && r.text.includes("update_issue"), "update_issue 被拒绝（issue_write 关）");
  r = await tool("delete_issue", { id: "iss_x" });
  assert(r.isError && r.text.includes("delete_issue"), "delete_issue 被拒绝（issue_write 关）");
  r = await tool("update_note", { rel: "笔记.md", content: "# 改\n" });
  assert(r.isError && r.text.includes("权限拒绝"), "update_note 被拒绝");
  r = await tool("delete_note", { rel: "笔记.md" });
  assert(r.isError && r.text.includes("权限拒绝") && r.text.includes("delete_note"), "delete_note 被拒绝");
  r = await tool("list_views", {});
  assert(r.isError && r.text.includes("list_views"), "list_views 被拒绝（view_read 关）");
  r = await tool("run_view", { rel: "views/x.yml" });
  assert(r.isError && r.text.includes("run_view"), "run_view 被拒绝（view_read 关）");
  r = await tool("create_view", { name: "x" });
  assert(r.isError && r.text.includes("create_view"), "create_view 被拒绝（view_write 关）");
  assert(!existsSync(join(vault, ".pkmx", "issues.json")), "管理类工具全部禁用时不会触发迁移");

  console.log("== 笔记与视图/内部数据隔离 ==");
  r = await tool("get_note", { rel: "views/x.yml" });
  assert(r.isError && r.text.includes("视图工具"), "get_note 拒绝视图路径并提示用视图工具");
  r = await tool("append_to_note", { rel: "views/x.yml", content: "x" });
  assert(r.isError && r.text.includes("视图工具"), "append_to_note（未禁用）也拒绝视图路径");
  r = await tool("get_note", { rel: ".pkmx/issues.json" });
  assert(r.isError && r.text.includes("内部数据目录") && r.text.includes("Issue 工具"), "get_note 拒绝内部 Issue 存储路径");

  console.log("== 放行路径 ==");
  r = await tool("append_to_note", { rel: "笔记.md", content: "追加一行" });
  assert(!r.isError, "append_to_note（未禁用）正常执行");
  r = await tool("get_note", { rel: "笔记.md" });
  assert(!r.isError && r.text.includes("追加一行"), "get_note 读到追加内容，只读工具不受影响");
  r = await tool("search_notes", { query: "初始" });
  assert(!r.isError, "search_notes 正常");

  console.log("== 热生效（同进程改配置） ==");
  setPerms(ALL_ON);
  r = await tool("create_note", { rel: "新笔记.md", content: "# 新\n" });
  assert(!r.isError, "改配置后 create_note 立即恢复（无需重启）");
  r = await tool("update_note", { rel: "笔记.md", content: "# 覆写\n" });
  assert(!r.isError, "update_note 恢复");
  r = await tool("get_note", { rel: ".pkmx/issues.json" });
  assert(r.isError && r.text.includes("内部数据目录"), "权限全开后笔记工具仍不可访问内部存储");
  r = await tool("delete_note", { rel: "新笔记.md" });
  assert(!r.isError, "delete_note 恢复");
  r = await tool("get_note", { rel: "新笔记.md" });
  assert(r.isError && r.text.includes("笔记不存在"), "删除后 get_note 返回友好错误");

  console.log("== 旧任务自动迁移 ==");
  r = await tool("list_issues", {});
  assert(!r.isError, "Issue 工具恢复后触发首次加载");
  let listed = JSON.parse(r.text);
  assert(listed.count === 1, `旧任务迁移为 1 个 Issue（实际 ${listed.count}）`);
  const migrated = listed.issues[0];
  assert(
    migrated.title === "旧任务标题" && migrated.status === "Doing" && migrated.priority === "High",
    "迁移保留标题/状态/优先级",
  );
  assert(migrated.due === "2026-12-31" && migrated.created === "2026-01-02" && migrated.body === "迁移前正文。", "迁移保留 due/created/正文");
  assert(migrated.legacy === "旧任务.md", "记录原路径用于幂等");
  assert(existsSync(join(vault, ".pkmx", "issues.json")), "Issue JSON 已写入");
  assert(!existsSync(join(vault, "旧任务.md")), "原 Markdown 已从笔记目录移除");
  assert(existsSync(join(vault, ".pkmx", "legacy-backup", "旧任务.md")), "原文件已备份");
  r = await tool("search_notes", { query: "迁移前正文" });
  assert(JSON.parse(r.text).count === 0, "迁移后的旧任务不再出现在笔记搜索中");

  console.log("== Issue CRUD ==");
  const today = localDate(0);
  const yesterday = localDate(-1);
  const farFuture = localDate(30);
  r = await tool("create_issue", {
    title: "发布 v1",
    status: "Doing",
    priority: "High",
    due: today,
    body: "验收标准见文档。",
  });
  assert(!r.isError, "create_issue 成功");
  const mainIssue = JSON.parse(r.text);
  assert(mainIssue.id.startsWith("iss_") && mainIssue.title === "发布 v1" && mainIssue.status === "Doing", "返回独立 id 与字段");
  assert(!existsSync(join(vault, "发布 v1.md")), "Issue 不生成 Markdown");
  assert(mainIssue.body === "验收标准见文档。" && mainIssue.legacy === undefined, "正文独立保存，无 legacy 字段");

  r = await tool("create_task", { title: "兼容别名", status: "Todo" });
  assert(!r.isError, "create_task 兼容别名成功");
  const aliasIssue = JSON.parse(r.text);
  assert(aliasIssue.id.startsWith("iss_") && !existsSync(join(vault, "兼容别名.md")), "别名同样写入独立 Issue 存储");
  r = await tool("create_task", { title: "坏状态", status: "InProgress" });
  assert(r.isError && r.text.includes("status"), "非法 status 被拒");
  r = await tool("create_issue", { title: "坏优先级", priority: "Critical" });
  assert(r.isError && r.text.includes("priority"), "非法 priority 被拒");
  r = await tool("create_task", { title: "坏日期", due: "2026-02-31" });
  assert(r.isError && r.text.includes("due"), "非法 due 被拒");

  r = await tool("list_issues", { status: "Doing" });
  listed = JSON.parse(r.text);
  assert(listed.count === 2 && listed.issues.some((i) => i.title === "发布 v1"), "list_issues status 过滤（含迁移 Issue）");
  r = await tool("list_issues", { priority: "High" });
  assert(JSON.parse(r.text).issues.every((i) => i.priority === "High"), "list_issues priority 过滤");
  r = await tool("list_issues", { text: "验收标准" });
  assert(JSON.parse(r.text).count === 1, "list_issues text 过滤正文");
  r = await tool("list_issues", { due: "today" });
  assert(JSON.parse(r.text).issues.some((i) => i.title === "发布 v1"), "list_issues due=today");
  r = await tool("list_issues", { limit: 1 });
  listed = JSON.parse(r.text);
  assert(listed.count === 1 && listed.issues.length === 1, "list_issues limit 生效");

  r = await tool("get_issue", { id: mainIssue.id });
  let fetched = JSON.parse(r.text);
  assert(fetched.status === "Doing" && typeof fetched.mtime === "number", "get_issue 返回内容与 mtime");
  r = await tool("update_issue", { id: mainIssue.id, body: "更新后的描述" });
  assert(!r.isError, "update_issue 部分字段更新");
  let updated = JSON.parse(r.text);
  assert(updated.body === "更新后的描述" && updated.status === "Doing" && updated.due === today, "未提供的字段保持不变");

  fetched = JSON.parse((await tool("get_issue", { id: mainIssue.id })).text);
  r = await tool("update_issue", { id: mainIssue.id, status: "Done", expected_mtime: fetched.mtime - 1 });
  assert(r.isError && r.text.includes("mtime 不匹配"), "过期 mtime 阻止更新");
  r = await tool("update_issue", { id: mainIssue.id, status: "Done", expected_mtime: fetched.mtime });
  updated = JSON.parse(r.text);
  assert(updated.status === "Done" && updated.done === localDate(0), "改为 Done 自动记录完成日期");
  fetched = JSON.parse((await tool("get_issue", { id: mainIssue.id })).text);
  r = await tool("update_issue", { id: mainIssue.id, status: "Todo", expected_mtime: fetched.mtime });
  updated = JSON.parse(r.text);
  assert(updated.done === undefined, "重新打开时清除完成日期");
  fetched = JSON.parse((await tool("get_issue", { id: mainIssue.id })).text);
  r = await tool("update_issue", { id: mainIssue.id, due: "", expected_mtime: fetched.mtime });
  assert(!r.isError && JSON.parse(r.text).due === undefined, "due 传空串可清空");

  fetched = JSON.parse((await tool("get_issue", { id: aliasIssue.id })).text);
  r = await tool("delete_issue", { id: aliasIssue.id, expected_mtime: fetched.mtime - 1 });
  assert(r.isError && r.text.includes("mtime 不匹配"), "delete_issue mtime 守卫生效");
  r = await tool("delete_issue", { id: aliasIssue.id, expected_mtime: fetched.mtime });
  assert(!r.isError, "delete_issue 成功");
  r = await tool("get_issue", { id: aliasIssue.id });
  assert(r.isError && r.text.includes("Issue 不存在"), "删除后 get_issue 返回友好错误");

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
  assert(gv.name === "测试视图" && gv.filters.status === "Doing, Blocked" && gv.filters.due === "week", "get_view 解析过滤条件");
  r = await tool("update_view", { rel: "views/测试视图.yml", status: "Doing, NA", expected_mtime: gv.mtime });
  assert(r.isError && r.text.includes("status") && r.text.includes("NA"), "update_view 拒绝非法 status 枚举值");
  r = await tool("update_view", { rel: "views/测试视图.yml", name: "改名视图", text: "设计", expected_mtime: gv.mtime });
  assert(!r.isError, "update_view 成功（带 mtime 守卫）");
  r = await tool("get_view", { rel: "views/测试视图.yml" });
  const gv2 = JSON.parse(r.text);
  assert(gv2.name === "改名视图" && gv2.filters.text === "设计" && gv2.filters.status === undefined, "update_view 全量替换过滤条件");
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
  r = await tool("create_issue", { title: "视图今天", status: "Doing", priority: "Urgent", due: today });
  assert(!r.isError, "创建今日 Issue");
  r = await tool("create_issue", { title: "视图逾期", status: "Todo", priority: "High", due: yesterday });
  assert(!r.isError, "创建逾期 Issue");
  r = await tool("create_issue", { title: "视图远期", status: "Blocked", priority: "Low", due: farFuture });
  assert(!r.isError, "创建远期 Issue");

  r = await tool("create_view", { name: "执行-今天", text: "视图", due: "today" });
  assert(!r.isError, "创建 due=today 视图");
  r = await tool("run_view", { rel: "views/执行-今天.yml" });
  let rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.issues[0].title === "视图今天", "run_view due=today 精确匹配");
  assert(
    rv.issues[0].status === "Doing" && rv.issues[0].priority === "Urgent" && rv.issues[0].due === today && rv.issues[0].id.startsWith("iss_"),
    "run_view 返回 Issue 元数据",
  );
  assert(rv.issues[0].rel === undefined && typeof rv.mtime === "number", "Issue 结果不带笔记路径，附存储 mtime");

  r = await tool("create_view", { name: "执行-逾期", text: "视图", due: "overdue" });
  r = await tool("run_view", { rel: "views/执行-逾期.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.issues[0].title === "视图逾期", "run_view due=overdue 只含过期 Issue");

  r = await tool("create_view", { name: "执行-状态", text: "视图", status: "Doing, Blocked" });
  r = await tool("run_view", { rel: "views/执行-状态.yml" });
  rv = JSON.parse(r.text);
  assert(
    rv.count === 2 && rv.issues.some((t) => t.title === "视图今天") && rv.issues.some((t) => t.title === "视图远期"),
    "run_view status 逗号多值匹配",
  );
  r = await tool("run_view", { rel: "views/执行-状态.yml", limit: 1 });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.issues.length === 1, "run_view limit 生效");

  r = await tool("create_view", { name: "执行-优先级", text: "视图", priority: "Urgent" });
  r = await tool("run_view", { rel: "views/执行-优先级.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.issues[0].title === "视图今天", "run_view priority 精确匹配");

  r = await tool("create_view", { name: "执行-本周", text: "视图", due: "week" });
  r = await tool("run_view", { rel: "views/执行-本周.yml" });
  rv = JSON.parse(r.text);
  assert(
    rv.issues.some((t) => t.title === "视图今天") && !rv.issues.some((t) => t.title === "视图远期"),
    "run_view due=week 含今天、排除 30 天后",
  );

  r = await tool("create_view", { name: "执行-文本", text: "逾期" });
  r = await tool("run_view", { rel: "views/执行-文本.yml" });
  rv = JSON.parse(r.text);
  assert(rv.count === 1 && rv.issues[0].title === "视图逾期", "run_view text 匹配标题");

  r = await tool("run_view", { rel: "views/不存在.yml" });
  assert(r.isError && r.text.includes("视图不存在"), "run_view 对缺失视图返回友好错误");
  r = await tool("run_view", { rel: "普通笔记.md" });
  assert(r.isError && r.text.includes("views/"), "run_view 拒绝非视图路径");
} finally {
  child.kill();
  if (backup !== null) writeFileSync(permsPath, backup);
  else if (existsSync(permsPath)) rmSync(permsPath);
  rmSync(vault, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
