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
- **"是否任务"仅由有无 `status` frontmatter 属性决定**——没有独立的任务/Issue 数据结构。
- 组织方式 = 文件夹 + 双链。无类型系统、无标签系统。

## frontmatter 约定

| 键 | 含义 |
| --- | --- |
| `status` | `Todo` / `Doing` / `Blocked` / `Done` / `Wont`。有此键即为任务 |
| `priority` | `Low` / `Normal` / `High` / `Urgent` |
| `due` | `YYYY-MM-DD`，截止日 |
| `done` | `YYYY-MM-DD`，status 变 Done 时写入 |
| `date` | `YYYY-MM-DD`，每日笔记的日期（文件名通常同日期） |
| `created` | 创建日期 |

## 特殊文件

- `views/*.yml` — 保存视图（扁平过滤：`name` / `status: A, B` / `priority: …` / `due: all|today|week|overdue` / `text: 关键词`）。
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

工具一览：

| 工具 | 说明 |
| --- | --- |
| `search_notes` | 按 `query` 匹配标题/正文，返回 `{rel, title}` 列表，`limit` 默认 20 |
| `get_note` | 读整篇：`content` + `mtime`（unix 秒）；拒绝 `views/` 路径 |
| `create_note` | 新建 `rel` + `content`；已存在则拒绝（用 update_note 覆写）；拒绝 `views/` 路径 |
| `update_note` | 整篇覆写；可带 `expected_mtime`（来自 get_note）做修改时间守卫，不匹配返回当前 mtime |
| `append_to_note` | 末尾追加 |
| `list_views` | 列出全部保存视图及过滤条件 `{rel, name, filters, mtime}` |
| `get_view` | 读单个视图：原始 yml `content` + 解析后 `filters` + `mtime` |
| `create_view` | 创建视图：`name` 必填，`status`/`priority`（逗号分隔）、`due`（all/today/week/overdue）、`text` 可选 → 写 `views/<name>.yml` |
| `update_view` | 修改视图：`rel` 必填；**过滤条件全量替换**（未提供的键移除，`name` 缺省保留原名）；支持 `expected_mtime` 守卫 |
| `delete_view` | 删除视图文件；支持 `expected_mtime` 守卫 |

笔记工具与视图工具路径互相隔离：笔记工具拒绝 `views/` 下的一切，视图工具只接受 `views/*.yml`。

建议工作流：`search_notes` → `get_note`（拿 mtime）→ 修改 → `update_note`（带 expected_mtime）。

### 写入权限

GUI（设置 → MCP）可分别禁用笔记写入与视图操作，配置持久化在用户配置目录 `pkmx/mcp.json`（Windows：`%APPDATA%\pkmx\mcp.json`），MCP 服务端**每次调用时重读**，改动即时生效、无需重启进程。默认（无配置文件）全部允许。

- 笔记组：`create_note` / `update_note` / `append_to_note` 三个独立开关
- 视图组：读取开关（`list_views` / `get_view`）与管理开关（`create_view` / `update_view` / `delete_view`）
- 禁用后调用返回错误：`权限拒绝：<工具名> 已在 PKMX 设置（MCP 权限）中禁用`
- `tools/list` 里被禁用工具的 description 会带 ⚠ 标注，接入的 agent 在列工具阶段即可感知
- 只读笔记工具 `search_notes` / `get_note` 不受影响

应用在运行中会监听仓库文件变化并实时同步——外部 agent 的写入会即时反映到界面；应用自身的写入也是普通文件操作，双方通过文件系统协作。
