export type Status = "Todo" | "Doing" | "Blocked" | "Done";
export type Priority = "Low" | "Normal" | "High" | "Urgent";

export const STATUSES: Status[] = ["Todo", "Doing", "Blocked", "Done"];
/** 看板只承载未归档状态；Done 标记后自动进入已归档 */
export const BOARD_STATUSES: Status[] = ["Todo", "Doing", "Blocked"];
export const STATUS_LABEL: Record<Status, string> = {
  Todo: "待办",
  Doing: "进行中",
  Blocked: "受阻",
  Done: "完成",
};
export const STATUS_COLOR: Record<Status, string> = {
  Todo: "var(--st-todo)",
  Doing: "var(--st-doing)",
  Blocked: "var(--st-blocked)",
  Done: "var(--st-done)",
};

export const PRIORITIES: Priority[] = ["Low", "Normal", "High", "Urgent"];
export const PRIORITY_LABEL: Record<Priority, string> = {
  Low: "低",
  Normal: "普通",
  High: "高",
  Urgent: "紧急",
};

/** 笔记 = 一个 Markdown 文件。任务/Issue 是独立数据，不再由笔记 frontmatter 表达。 */
export interface Note {
  /** 状态内唯一 id：主仓库=相对路径；同时加载的额外仓库=`仓库名::相对路径` */
  id: string;
  folder: string;
  fileName: string;
  title: string;
  body: string;
  /** 旧版任务 frontmatter 的透传字段：仅为避免源码模式编辑时丢数据，不再参与任何任务逻辑 */
  status?: Status;
  priority?: Priority;
  due?: string;
  done?: string;
  /** 日记笔记的日期 */
  date?: string;
  created?: string;
  /** 额外仓库（同时加载）的归属信息；主仓库笔记无这三个字段 */
  rel?: string;
  vaultRoot?: string;
  vaultName?: string;
  /** 文件扩展名（小写，不含点）；md 笔记缺省为 "md" */
  ext?: string;
  /** 非 Markdown 的办公文档（docx/xlsx/pptx/pdf 等）：只展示与定位，不走 Markdown 编辑器 */
  doc?: boolean;
}

/** Issue = 项目进度管理条目，独立保存在 `<仓库>/.pkmx/issues.json`，与笔记文件互不影响。 */
export interface Issue {
  id: string;
  title: string;
  body: string;
  status: Status;
  priority: Priority;
  /** YYYY-MM-DD */
  due?: string;
  done?: string;
  created: string;
  updated: string;
  /** 从旧 Markdown 任务迁移而来时的原相对路径（迁移幂等用，界面不展示） */
  legacy?: string;
}

export interface IssueSnapshot {
  issues: Issue[];
  mtime: number;
  /** 本次加载新迁移的旧任务路径 */
  migrated: string[];
  /** 已从笔记目录移除的旧任务路径 */
  removed: string[];
}
