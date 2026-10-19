import type { Note } from "./types";

/** 支持展示的办公文档扩展名（不含 md；旧版二进制格式走系统打开兜底） */
export const DOC_EXTS = ["docx", "xlsx", "pptx", "pdf", "doc", "xls", "ppt"] as const;
export const DOC_EXT_SET = new Set<string>(DOC_EXTS);

export const extOf = (fileName: string): string =>
  fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";

export const isDocFile = (fileName: string): boolean => DOC_EXT_SET.has(extOf(fileName));

/** 应用内原生渲染的格式（xls 走 SheetJS 的 BIFF 解析，其余旧格式用系统默认程序打开） */
export const renderableInApp = (ext: string): boolean => ["docx", "xlsx", "xls", "pdf"].includes(ext);

/** 工作表应用内查看的行列上限（超出截断并提示，完整内容走系统程序） */
export const SHEET_VIEW_MAX_ROWS = 10000;
export const SHEET_VIEW_MAX_COLS = 1000;

/* SheetJS 工具子集（只依赖用到的方法，便于测试替身） */
interface XLSXUtilsLike {
  decode_cell: (addr: string) => { r: number; c: number };
  encode_range: (r: { s: { r: number; c: number }; e: { r: number; c: number } }) => string;
}
export interface WorkSheetLike {
  [key: string]: unknown;
  "!ref"?: string;
  "!data"?: unknown[][];
}

/**
 * 把工作表 !ref 收敛到实际有数据的范围（并受查看上限约束）。
 * Excel 常因整列/整行格式化把 dimension 声明成 A1:XFD1048576，数据其实
 * 只有几十格；sheet_to_html 按声明范围迭代，在 webview 里会以
 * RangeError: Array buffer allocation failed 或卡死收场。
 * 返回收敛后的行列数与是否被上限截断。
 */
export function clampSheetRange(
  X: XLSXUtilsLike,
  ws: WorkSheetLike,
  maxRows = SHEET_VIEW_MAX_ROWS,
  maxCols = SHEET_VIEW_MAX_COLS,
): { rows: number; cols: number; truncated: boolean } {
  let eRow = 0;
  let eCol = 0;
  const dense = ws["!data"];
  if (Array.isArray(dense)) {
    for (let r = 0; r < dense.length; r++) {
      const row = dense[r];
      if (!Array.isArray(row)) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (row[c] != null) {
          if (r > eRow) eRow = r;
          if (c > eCol) eCol = c;
          break;
        }
      }
    }
  } else {
    let sawAddr = false;
    let hasOtherKeys = false;
    for (const key of Object.keys(ws)) {
      if (key.charCodeAt(0) === 33 /* ! */) continue;
      let addr: { r: number; c: number };
      try {
        addr = X.decode_cell(key);
      } catch {
        hasOtherKeys = true; // 非单元格键（如旧版误传 dense 产生的数字行键）
        continue;
      }
      if (addr.r < 0 || addr.c < 0) {
        // 解析失败不抛而返回 -1 哨兵的实现，同样按非单元格键处理
        hasOtherKeys = true;
        continue;
      }
      sawAddr = true;
      if (addr.r > eRow) eRow = addr.r;
      if (addr.c > eCol) eCol = addr.c;
    }
    // 无法识别的结构（非空但无单元格地址键）：别动 !ref，交给 SheetJS 自身处理
    if (!sawAddr && hasOtherKeys) return { rows: 0, cols: 0, truncated: false };
  }
  const truncated = eRow >= maxRows || eCol >= maxCols;
  const end = { r: Math.min(eRow, maxRows - 1), c: Math.min(eCol, maxCols - 1) };
  ws["!ref"] = X.encode_range({ s: { r: 0, c: 0 }, e: end });
  return { rows: end.r + 1, cols: end.c + 1, truncated };
}

/** 文档文件 → 树条目（title = 不含扩展名的文件名，展示时补 .ext 徽标） */
export function toDocNote(
  relPath: string,
  vault?: { root: string; name: string },
): Note {
  const parts = relPath.split("/");
  const fileName = parts.pop() ?? relPath;
  const innerFolder = parts.join("/");
  const ext = extOf(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length - 1);
  const base: Note = {
    id: "",
    folder: innerFolder,
    fileName,
    title: stem,
    body: "",
    ext,
    doc: true,
  };
  if (vault) {
    return {
      ...base,
      id: `${vault.name}::${relPath}`,
      folder: innerFolder ? `${vault.name}/${innerFolder}` : vault.name,
      rel: relPath,
      vaultRoot: vault.root,
      vaultName: vault.name,
    };
  }
  return { ...base, id: relPath, rel: relPath };
}
