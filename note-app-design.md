# PKMX — 设计方案（v3，随实现演进更新）

> 定位：**本地优先的 Markdown 笔记应用，内置独立的项目 Issue 管理**。笔记走文件系统，Issue 走仓库内独立 JSON，二者互不混杂。
> v3 要点（2026-10-14 定稿）：无类型系统、无 Git、无收件箱——组织方式参照 Obsidian（文件夹树 + 双链）；v1 方案中的类型/关系/项目/Git 章节已被本版取代。
> v4 变更（2026-10-19）：任务不再由笔记 frontmatter 表达。Issue 独立存储于 `<仓库>/.pkmx/issues.json`，旧任务自动迁移并备份。
> 竞品证据（Obsidian 1.12.4 / Tolaria 2026.9.24 的 REA 逆向分析）见文末；原始证据包为一次性分析产物，涉及第三方内容，未保留。

---

## 1. 产品原则

1. **文件优先**：仓库就是一个普通文件夹，笔记是 `.md` 文件；删掉应用，数据完整可用。
2. **笔记与 Issue 分离**：笔记承载长文与上下文；Issue 是轻量的项目进度条目（标题/描述/状态/优先级/截止日期），不写入 Markdown 文件。
3. **Issue 有独立数据结构**：保存在仓库内 `.pkmx/issues.json`（原子写入、mtime 守卫）；视图 = 对 Issue 的保存过滤器。日报仍可聚合当天到期/完成的 Issue。
4. **捕获快，整理慢**；**不做项目管理工具**（无迭代/燃尽图/成员）。
5. **开放性 = 文件 + MCP**：不搞插件市场，应用本身可作 MCP 服务器供 AI agent 读写笔记、Issue 与视图。

## 2. 数据模型

笔记（`.md`，不含任务属性）：

```md
---
date: 2026-10-19   # 每日笔记
created: 2026-10-01
---

# 标题取自第一个 H1（与文件名解耦）

正文支持 [[双链]]、- [ ] 勾选项（可一键转为 Issue，可带 @due(YYYY-MM-DD)）、**加粗**、
> [!note] 提示、代码块、![图片](attachments/xxx.png)。
```

Issue（`.pkmx/issues.json`，version 1）：

```json
{
  "version": 1,
  "issues": [{
    "id": "iss_...", "title": "修复登录超时", "body": "复现步骤…",
    "status": "Doing", "priority": "High", "due": "2026-10-31",
    "done": null, "created": "2026-10-19", "updated": "2026-10-19"
  }]
}
```

- `status`：Todo / Doing / Blocked / Done；`priority`：Low / Normal / High / Urgent。改 Done 自动写 `done` 日期并归档。
- 组织 = 文件夹 + 双链（反向链接面板）。
- 特殊文件：`.pkmx/issues.json`（Issue）、`.pkmx/legacy-backup/`（旧任务迁移备份）、`views/*.yml`（保存视图）、`attachments/`（附件）、`YYYY-MM-DD.md`（每日笔记）。
- 旧任务迁移：首次加载时扫描带合法 `status` frontmatter 的笔记生成 Issue；先写 JSON，再把原文件备份到 `.pkmx/legacy-backup/` 并从原位置删除，`legacy` 字段保证幂等与重试。
- 未解析双链：点击先确认再创建（防误触）。

## 3. 功能清单（已实现）

**笔记**：文件夹树（可折叠）/ **阅读 · 块编辑 · 源码三态**（块编辑：正文按块渲染，点击段落就地编辑源码，Ctrl+Enter 完成、Esc 取消、失焦提交，`[[` 补全与粘贴图片同源码模式，勾选项全局索引跨块对齐）/ 日记属性条 / 大纲 + 反向链接右栏 / 宽版 / 重命名 / 删除 / 移动 / 新建笔记与文件夹 / 粘贴图片自动存 `attachments/` 并插入引用 / 全文搜索（Ctrl+F 进入：桌面模式 Rust 侧 tantivy 索引，中文 2-gram、BM25 排序、mtime 毫秒级增量同步，单字符回退扫描，跨已加载仓库，片段高亮）/ 快速打开（顶栏搜索按钮 / Ctrl+P，按标题与文件名跳转）/ 阅读模式选中文字一键转双链。

**Issue（独立数据）**：独立 JSON 存储（`.pkmx/issues.json`）/ **Issue 看板**（按状态分列：待办·进行中·受阻，拖拽卡片改状态、列内 `+` 新建、状态筛选，右键可标记完成并自动归档；2026-10-19 合并原「未完成」「已完成」视图并移除放弃功能）/ **已归档任务**（已完成 Issue 自动归档，按归档日期区间筛选，Done 盖"讫"印章，右键可重新打开或删除）/ **工作报告**（日报·周报·月报周期切换，仅汇总状态为 Done 的 Issue，渲染为文档并可复制 Markdown，右键可复制或切换周期）/ 保存视图（views/*.yml 由文件定义，侧栏自动列出、可删除；UI 可新建 Issue 并按视图筛选）/ Issue 编辑器（状态、优先级、截止日期、Markdown 描述、自动保存、删除确认）/ 笔记勾选项一键转 Issue / 旧任务自动迁移并备份。图谱视图已于 2026-10-19 移除。

**工作日志**：今日笔记（笔记菜单 →「今日笔记」，按需创建）注入区实时聚合当天到期/完成的 Issue，可"固化"为正文静态文本。

**捕获**：Ctrl+N 一句话存笔记（默认文档地址）；可在弹窗中直接创建 Issue。

**打开（原"导入"，2026-10-15 改为原地打开）**：笔记可在本地任意目录——新建菜单"打开文件…/打开文件夹…"，文件夹作为仓库加入文件树（原地读写 + 独立监听），单个 .md 以其所在目录注册为受限仓库只跟踪该文件（不复制、不动原位置）；拖放同规则（桌面原生拖放事件 / 浏览器 HTML5 读文本）。新建笔记写入主仓库，「设置 → 通用 → 默认文档地址」可指定其落脚子目录（留空即仓库根目录）。**本地文件是唯一事实源**：每次打开笔记从磁盘重读（外部修改即时可见，正在编辑时不覆盖）；watcher 持续同步增/改/删。

**办公文档**：仓库/打开的文件夹里的 docx·xlsx·pptx·pdf 及旧版 doc·xls·ppt 一并进入文件树，条目尾部显示扩展名徽标（长文件名截断省略但扩展名永不隐藏，Excel/演示用专属图标）；点击进入文档查看器——pdf 内嵌预览、docx 应用内渲染（docx-preview）、xlsx 表格化展示（SheetJS，多工作表页签），旧格式与读取失败走"系统默认程序打开"兜底（顶部还有 系统打开/资源管理器定位/删除）。文档只展示与定位：不可编辑、移动/重命名走系统（右键菜单对应项自动隐藏），watcher 同步增删。依赖 docx-preview 与 xlsx 按需动态加载。

**右键菜单**：全局屏蔽浏览器原生菜单（文本输入框保留原生以支持粘贴），应用自绘——文件树笔记行（打开/重命名/移动到文件夹/删除/在资源管理器中显示；文档行为 打开/删除/定位）、文件树目录行（在此新建笔记/新建子文件夹/重命名/删除文件夹/在资源管理器中打开；同时加载的仓库顶层只有 卸载此仓库/在资源管理器中打开）、正文区（重命名/移动/删除/定位）、文件树与正文空白处（新建笔记/快速捕获/设置；视图页面与侧栏视图项不弹）。

**弹窗与危险操作**：所有弹窗（捕获/快速打开/输入/确认）在窗口正中弹出；删除任何本地文件（笔记或办公文档）前弹居中确认对话框（红字"删除"，Enter 确认 / Esc 取消），文案明示"将删除本地文件，不可恢复"。

**开放（M4）**：`pkmx.exe --mcp --vault <dir>` 即 MCP stdio 服务器——笔记工具 search_notes / get_note / create_note / update_note（mtime 守卫）/ append_to_note / delete_note；Issue 工具 list_issues / get_issue / create_issue / update_issue / delete_issue（独立 JSON，mtime 守卫；create_task 为兼容别名）；视图工具 list_views / get_view / run_view / create_view / update_view / delete_view；agent-docs 随仓库提供。

**桌面**：文件监听（外部编辑与 `.pkmx/issues.json` 修改实时同步，写入回声过滤，每仓库独立 watcher）/ **多仓库同时加载**（文件树「打开文件夹…」或拖入文件夹合并其他仓库进文件树，独立读写与监听）/ 昼白·夜墨双主题 / 错误边界 / `--vault <dir>` 启动直开。

## 4. 技术栈

Tauri 2 · React 19 · Vite 8 · TypeScript 6 · Tailwind CSS 4 · shadcn/ui（radix）· zustand 5 · sonner · cmdk · Rust（notify 8 文件监听 · tantivy 0.24 全文索引）。
体积实绩：NSIS 安装包 **2.61 MiB**（引入 tantivy 索引后；此前 1.58 MiB；竞品 Obsidian 约 300MB）。

架构：前端持有全量笔记（解析 frontmatter）与 Issue（独立 JSON，400ms 防抖 + 串行写队列），所有变更即时写盘；Rust 侧文件命令（list/read/write/delete/read_bin/write_bin/watch）+ Issue 存储命令（load/save，原子写）+ vault_search 索引搜索 + MCP 模式复用同一套 vault 代码。Issue 与笔记分属两套数据和 watcher 分支，`.pkmx` 隐藏目录不进入笔记树、搜索索引或文件树。索引要点：自实现滑动 2-gram 分词器（tantivy 自带 NgramTokenizer 的 position 恒为 0，短语查询无法命中），词内 bigram 短语匹配等价子串匹配，词间 AND；每仓库一个内存索引，查询前按 mtime（毫秒）增量对账。

## 5. 里程碑状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M1 笔记核心 | 文件树/双模式编辑器/双链/移动/重命名/删除/附件/全文搜索 | ✅ |
| M2 Issue 层 | Issue 独立 JSON/旧任务迁移/编辑器/保存视图/看板·已归档·工作报告（2026-10-19 从笔记 frontmatter 重构并合并列表视图） | ✅ |
| M3 工作日志 | Daily 模板/自动聚合/固化/勾选项互转 | ✅ |
| M4 开放 | MCP 18 工具（笔记 / Issue / 视图）+ agent-docs + 文件监听 | ✅ |
| M5 打磨 | 设置面板/多仓库/主题/图标/安装包 | ✅ |
| M6 未来项落地 | 富文本块编辑 / tantivy 全文索引 | ✅ 2026-10-14 |
| 未来 | 块编辑工具条（加粗等快捷按钮）、索引落盘复用、移动端 | 待定 |

## 6. 竞品证据（REA 静态分析摘要）

- **Obsidian 1.12.4**（Electron，asar 23MB）：内嵌 CodeMirror/PDF.js/MathJax/Mermaid/PixiJS 等；18 个核心插件经字节级 grep 验证；任务管理靠社区插件约定。→ 取其文件树+阅读视图形态。
- **Tolaria 2026.9.24**（Tauri，34MB 单文件）：Markdown+frontmatter、status 属性+保存视图表达任务、内建 Git、随包 agent-docs 与 MCP（search/get/create/update/append 五工具，update 带 mtime 守卫）。→ 取"status+视图"与 MCP 设计，弃类型系统与 Git。
- 完整证据包（REA complete-record ×2）为一次性分析产物，涉及第三方内容，未保留。

交互原型（HTML 参照稿）：`prototype/index.html`。实现代码：仓库根目录（Tauri 应用本体，2026-10-15 由 `inkwell/` 子目录提升而来）。
