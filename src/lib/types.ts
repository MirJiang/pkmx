export type Status = "Todo" | "Doing" | "Blocked" | "Done" | "Wont";
export type Priority = "Low" | "Normal" | "High" | "Urgent";

export const STATUSES: Status[] = ["Todo", "Doing", "Blocked", "Done", "Wont"];
export const STATUS_LABEL: Record<Status, string> = {
  Todo: "待办",
  Doing: "进行中",
  Blocked: "受阻",
  Done: "完成",
  Wont: "放弃",
};
export const STATUS_COLOR: Record<Status, string> = {
  Todo: "var(--st-todo)",
  Doing: "var(--st-doing)",
  Blocked: "var(--st-blocked)",
  Done: "var(--st-done)",
  Wont: "var(--st-wont)",
};

export const PRIORITIES: Priority[] = ["Low", "Normal", "High", "Urgent"];
export const PRIORITY_LABEL: Record<Priority, string> = {
  Low: "低",
  Normal: "普通",
  High: "高",
  Urgent: "紧急",
};

/** 笔记 = 一个 Markdown 文件。是否"任务"仅由 status 属性决定。 */
export interface Note {
  /** 状态内唯一 id：主仓库=相对路径；同时加载的额外仓库=`仓库名::相对路径` */
  id: string;
  folder: string;
  fileName: string;
  title: string;
  body: string;
  status?: Status;
  priority?: Priority;
  /** YYYY-MM-DD */
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
