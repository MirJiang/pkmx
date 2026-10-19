# PKMX — Agent 文档

给 AI agent（与未来的人类协作者）的仓库模型说明。

## 启动方式

- `pkmx.exe`：GUI，首次选择仓库文件夹，之后记住（localStorage）。
- `pkmx.exe --vault D:\path\to\vault`：GUI 直开指定仓库，跳过选择界面。
- `pkmx.exe --mcp --vault D:\path\to\vault`：作为 MCP stdio 服务器运行（见下）。
- GUI 顶栏「仓库管理」（或文件树的「打开文件夹…」、拖入文件夹）支持**多仓库同时加载**：其他仓库以仓库名为顶层文件夹合并进文件树，可正常读写，每个仓库有独立文件监听。

## 核心模型

- 仓库（vault）= 一个普通文件夹，**文件系统是唯一事实来源**，应用状态皆为派生缓存。
- 笔记 = 仓库内的 `.md` 文件，可带 YAML frontmatter（扁平标量键）。
- 标题取自正文第一个 `# 一级标题`；没有 H1 时取文件名（去 `.md`）。**标题与文件名解耦**。
- `[[双链]]` 出现在正文中，按标题解析。
- 组织方式 = 文件夹 + 双链。无类型系统、无标签系统。
- **Issue（项目进度管理）与笔记完全独立**：Issue 不写入 Markdown，也不参与笔记扫描、全文索引或文件树，统一保存在 `<仓库>/.pkmx/issues.json`。侧栏「Issue 看板 / 已归档 / 工作报告 / 保存视图」展示的是 Issue，不是笔记。

## Issue 存储

`.pkmx/issues.json`（隐藏目录，笔记工具不可访问）：

```json
{
  "version": 1,
  "issues": [
    {
      "id": "iss_18f..._0",
      "title": "修复登录超时",
      "body": "复现步骤与验收标准…",
      "status": "Todo",
      "priority": "Normal",
      "due": "2026-10-31",
      "done": "2026-10-20",
      "created": "2026-10-19",
      "updated": "2026-10-19"
    }
  ]
}
```

- `status`：`Todo` / `Doing` / `Blocked` / `Done`；`priority`：`Low` / `Normal` / `High` / `Urgent`。
- `due` / `done`：`YYYY-MM-DD`，可缺省。状态改为 `Done` 时自动写入 `done`，重新打开时清除。
- 写入为原子替换（临时文件 + rename）；MCP 写操作支持 `expected_mtime`（unix 毫秒）守卫。
- GUI 修改后 400ms 防抖落盘，写请求串行；`.pkmx/issues.json` 被外部修改时界面自动热更新。

### 旧任务迁移

旧版本的「带 `status` frontmatter 的 Markdown 任务」会在仓库首次加载时自动迁移：

1. 解析 `status` / `priority` / `due` / `done` / `created` 生成 Issue（正文去掉一级标题）；
2. 先写 `.pkmx/issues.json`；
3. 把原文件备份到 `.pkmx/legacy-backup/<原相对路径>`，再从原位置删除；
4. Issue 上的 `legacy` 字段记录原路径，用于幂等与删除失败重试。

迁移后原 Markdown 不再出现在笔记树与搜索中；备份保留在隐藏目录，可手工恢复。

## 笔记 frontmatter 约定

| 键 | 含义 |
| --- | --- |
| `date` | `YYYY-MM-DD`，每日笔记的日期（文件名通常同日期） |
| `created` | 创建日期 |

旧任务键 `status` / `priority` / `due` / `done` 现在只用于上述一次性迁移；新建笔记不再通过 frontmatter 表达任务。

## 特殊文件

- `.pkmx/issues.json` — Issue 独立存储（见上）。
- `.pkmx/legacy-backup/` — 旧任务迁移备份（保持原相对路径）。
- `views/*.yml` — 保存视图（扁平过滤：`name` / `status: A, B` / `priority: …` / `due: all|today|week|overdue` / `text: 关键词`），用于筛选 Issue。
- `attachments/` — 粘贴图片的存放处。
- `YYYY-MM-DD.md` — 每日工作记录（今日聚焦 checkbox + 自由记录）。

## MCP 服务器

本程序可直接作为 MCP stdio 服务器运行：

```
pkmx.exe --mcp --vault D:\path\to\vault
```

在 Claude Code 等客户端注册（示例）：

```json
{
  "mcpServers": {
    "pkmx": {
      "command": "D:\\path\\to\\pkmx.exe",
      "args": ["--mcp", "--vault", "D:\\path\\to\\vault"]
    }
  }
}
```

工具一览（18 个）：

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 按 `query` 匹配笔记标题/正文，返回 `{rel, title, snippet}`，`limit` 默认 20 |
| `get_note` | 读整篇：`content` + `mtime`（unix 毫秒）；拒绝 `views/` 与 `.pkmx/` 等内部路径 |
| `create_note` | 新建 `rel` + `content`；已存在则拒绝（用 update_note 覆写）；拒绝内部路径 |
| `update_note` | 整篇覆写（笔记必须已存在，不会隐式新建）；可带 `expected_mtime`（来自 get_note）做修改时间守卫 |
| `append_to_note` | 末尾追加（笔记必须已存在） |
| `delete_note` | 删除笔记（不可恢复）；可带 `expected_mtime` 守卫；拒绝内部路径 |
| `list_issues` | 列出 Issue：按 `status` / `priority`（逗号分隔）、`due`（all/today/week/overdue）、`text`、`limit`（默认 100）过滤，按截止日期排序 |
| `get_issue` | 按 `id` 读取 Issue 完整内容 + Issue 存储 `mtime`（unix 毫秒） |
| `create_issue` | 创建 Issue：`title` 必填，`body` / `status`（默认 Todo）/`priority`（默认 Normal）/`due` 可选；返回含 `id` 与 `mtime` |
| `update_issue` | 按 `id` 修改（只更新提供的字段）；`due` 传空串清空；改为 Done 自动记录完成日期；支持 `expected_mtime` |
| `delete_issue` | 按 `id` 删除 Issue；支持 `expected_mtime` 守卫 |
| `create_task` | `create_issue` 的兼容别名，同样写入 `.pkmx/issues.json` |
| `list_views` | 列出全部保存视图及过滤条件 `{rel, name, filters, mtime}` |
| `get_view` | 读单个视图：原始 yml `content` + 解析后 `filters` + `mtime` |
| `run_view` | 执行保存视图：返回匹配 Issue `{count, issues, mtime}`，`limit` 默认 100；过滤语义与界面一致（`due=week` 为本地时区周一至周日，`overdue` 为早于今天） |
| `create_view` | 创建视图 → 写 `views/<name>.yml`；`status` / `priority` 枚举校验 |
| `update_view` | 修改视图：**过滤条件全量替换**（未提供的键移除，`name` 缺省保留原名）；支持 `expected_mtime` |
| `delete_view` | 删除视图文件；支持 `expected_mtime` 守卫 |

笔记、Issue、视图三组工具路径互相隔离：笔记工具拒绝 `views/` 和 `.pkmx/` 等内部路径；视图工具只接受 `views/*.yml`；Issue 只能通过 Issue 工具访问。

文件不存在时返回可操作的错误（如「笔记不存在：…；可先用 search_notes 查找正确路径」/「Issue 不存在：…；可先用 list_issues 查看」），不会抛出底层系统错误；`update_note` / `append_to_note` 不会隐式创建文件。

建议工作流：

- 笔记：`search_notes` → `get_note`（拿 mtime）→ 修改 → `update_note`（带 expected_mtime）。
- Issue：`list_issues` → `get_issue`（拿 id 与 mtime）→ `update_issue`（带 expected_mtime）；新建用 `create_issue`。

Issue 与视图的关系：视图是 Issue 的保存过滤器（`status` / `priority` / `due` / `text`），通过 6 个视图工具管理；`run_view` 返回 Issue 列表。

### 默认文档地址

「设置 → 通用 → 默认文档地址」只影响 GUI 内新建的笔记（含快速捕获）所在的仓库子目录，不影响 Issue（Issue 固定存于 `.pkmx/issues.json`）。该设置通过用户配置目录的 `pkmx/settings.json` 在 GUI 与 MCP 进程间共享；MCP 的 `create_note` 仍需显式传入 `rel`。

### 写入权限

GUI（设置 → MCP）可分别禁用笔记写入、Issue 读写与视图操作，配置持久化在用户配置目录 `pkmx/mcp.json`（Windows：`%APPDATA%\pkmx\mcp.json`），MCP 服务端**每次调用时重读**，改动即时生效、无需重启进程。默认（无配置文件）全部允许。

- 笔记组：`create_note`、`update_note`、`append_to_note`、`delete_note` 各自独立开关
- Issue 组：读取开关（`list_issues` / `get_issue`）与管理开关（`create_issue` / `update_issue` / `delete_issue`，`create_task` 同属管理开关）
- 视图组：读取开关（`list_views` / `get_view` / `run_view`）与管理开关（`create_view` / `update_view` / `delete_view`）
- 禁用后调用返回错误：`权限拒绝：<工具名> 已在 PKMX 设置（MCP 权限）中禁用`
- `tools/list` 里被禁用工具的 description 会带 ⚠ 标注，接入的 agent 在列工具阶段即可感知
- 只读笔记工具 `search_notes` / `get_note` 不受写入开关影响

应用在运行中会监听仓库文件变化并实时同步——外部 agent 写入笔记或 Issue 存储后，界面都会自动更新；应用自身的写入也是普通文件操作，双方通过文件系统协作。
