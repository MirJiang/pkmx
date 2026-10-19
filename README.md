# PKMX

本地优先的笔记应用。主功能是笔记；待办便签 / 轻量 issues / 每日工作记录是同一数据模型上的视图——**任务只是带 `status` 属性的笔记**。

MIT License · Tauri 2 · React 19 · Vite 8 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui (radix) · zustand · sonner · Rust (notify · tantivy)

## 运行与构建

```bash
npm install
npm run dev          # 浏览器开发（内存仓库，不碰磁盘）
npm run tauri dev    # 桌面壳（首次编译 Rust 较慢）
npm run tauri build  # 打包：exe + NSIS 安装包（约 2.6 MiB）
```

- **浏览器模式**：数据在内存（无磁盘权限，空仓库起步），刷新即重置。
- **桌面模式**：首次启动选择文件夹作为仓库（之后自动记住）。仓库是普通文件夹，应用只读写其中的 Markdown/YAML/附件。
- **MCP 模式**：`pkmx.exe --mcp --vault <目录>` 直接作为 MCP stdio 服务器运行（见下）。

## 数据模型

```md
---
status: Doing      # Todo|Doing|Blocked|Done|Wont —— 有 status 即为任务
priority: High     # Low|Normal|High|Urgent
due: 2026-10-16
---

# 标题取自第一个 H1（与文件名解耦）

正文：[[双链]]、- [ ] 勾选项（可 @due(2026-10-16)）、**加粗**、
> [!note] 提示、代码块、![](attachments/x.png) 粘贴图片。
```

特殊文件：`views/*.yml` 保存视图 · `attachments/` 附件 · `YYYY-MM-DD.md` 每日笔记。

## 功能

- **笔记**：文件夹树 / 阅读·源码双模式（源码=整文件直编 + `[[` 补全）/ 属性条 / 大纲·反向链接 / 重命名·删除·移动·新建 / 粘贴图片落盘 / 全文搜索（Ctrl+F，桌面模式走 Rust 侧扫描）/ 图谱 / 快速打开（Ctrl+P）/ 阅读模式选中文字一键转双链
- **文件夹**：右键新建子文件夹 / 重命名（磁盘目录整体改名，里面文件一并跟随）/ 递归删除（二次确认，含办公文档与附件）/ 在资源管理器中打开；空目录不落盘，新建时写一篇同名占位笔记
- **任务**：未完成（逾期 / 今天 / 未来 / 无截止日期分组）/ 已完成（当日 / 七天 / 三十天）/ 保存视图（UI 新建，存 views/）/ 勾选项 ⇄ 任务笔记互转
- **日志**：今日笔记自动聚合到期与完成，可固化进正文
- **捕获**：Ctrl+N 一句话便签
- **同步**：桌面模式监听文件变化，外部编辑器/agent 改动实时反映；**多仓库同时加载**（顶栏「仓库管理」、文件树的「打开文件夹…」或直接拖入文件夹，把其他仓库合并进文件树，独立监听、独立读写）
- **默认文档地址**：设置 → 通用 指定新建笔记与快速捕获的落脚目录（仓库内相对路径，留空即根目录）
- **窗口**：无边框自定义标题栏（顶栏左侧「仓库管理 / 新建笔记」，可拖拽、双击最大化、最小化/最大化/关闭）
- **主题**：昼白 / 夜墨

## MCP（AI 访问仓库）

```json
{ "mcpServers": { "pkmx": {
    "command": "D:\\path\\pkmx.exe",
    "args": ["--mcp", "--vault", "D:\\path\\vault"] } } }
```

笔记工具：`search_notes` / `get_note`（含 mtime）/ `create_note` / `update_note`（mtime 守卫防读改写竞争）/ `append_to_note`。视图工具：`list_views` / `get_view` / `create_view` / `update_view` / `delete_view`。写入权限可在设置中分组开关。详见 [agent-docs/AGENTS.md](agent-docs/AGENTS.md)。

## 结构

```
src/lib/      types / dates / frontmatter / markdown / vault(仓库抽象) / graph / office / themes
src/store.ts  zustand 全局状态、写盘、文件监听、领域逻辑
src/components/ Titlebar / Sidebar+FileTree / Editor / DocView / Views(未完成·已完成·保存视图) /
               SearchView / GraphView / CaptureDialog / QuickOpen / PromptDialog /
               SettingsView / VaultDialog / VaultGate / Chips / Statusbar
src-tauri/src/lib.rs  文件命令 + notify 监听 + tantivy 搜索 + --mcp stdio 服务器
```

手动测试脚本在 `scripts/`：`test-graph.ts`、`test-sheet-clamp.ts`、`test-office.mjs`、`test-mcp.mjs`、`test-mcp-perms.mjs`（后两者需已打包的 `pkmx.exe`）。

设计文档：[note-app-design.md](note-app-design.md)（v3）· 交互原型：[prototype/index.html](prototype/index.html)

## 许可证

[MIT](LICENSE)
