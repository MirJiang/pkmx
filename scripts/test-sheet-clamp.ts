/**
 * clampSheetRange 回归（node --experimental-strip-types scripts/test-sheet-clamp.ts）：
 * 覆盖幻影范围收敛、稀疏空洞、行列截断、dense 模式、空表，并验证收敛后 sheet_to_html 可正常完成。
 */
import { createRequire } from "node:module";
import { clampSheetRange, SHEET_VIEW_MAX_ROWS } from "../src/lib/office.ts";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

let failed = 0;
const ok = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
};

// 1. 幻影范围：声明 A1:XFD1048576，实际只有 3x3
{
  const ws = XLSX.utils.aoa_to_sheet([
    ["项目", "进度", "负责人"],
    ["块编辑", 1.0, "张三"],
    ["tantivy", 0.9, "李四"],
  ]);
  ws["!ref"] = "A1:XFD1048576";
  const t0 = Date.now();
  const info = clampSheetRange(XLSX.utils, ws);
  const html = XLSX.utils.sheet_to_html(ws);
  const ms = Date.now() - t0;
  ok(ws["!ref"] === "A1:C3", `幻影范围收敛到实际数据 A1:C3（实际 ${ws["!ref"]}）`);
  ok(html.includes("tantivy") && html.includes("张三"), "收敛后 sheet_to_html 内容完整");
  ok(!info.truncated && info.rows === 3 && info.cols === 3, "行列数与截断标记正确");
  ok(ms < 1000, `收敛+渲染在 1s 内完成（${ms}ms，不收敛会卡死/爆内存）`);
}

// 2. 稀疏空洞：A1 与 E10，中间全空
{
  const ws = XLSX.utils.aoa_to_sheet([["起点"]]);
  ws["E10"] = { t: "s", v: "远端" };
  clampSheetRange(XLSX.utils, ws);
  ok(ws["!ref"] === "A1:E10", `稀疏空洞按实际数据边界收敛（实际 ${ws["!ref"]}）`);
  ok(XLSX.utils.sheet_to_html(ws).includes("远端"), "远端单元格仍渲染");
}

// 3. 超上限截断：数据在第 20001 行
{
  const ws = XLSX.utils.aoa_to_sheet([["表头"]]);
  ws["A20001"] = { t: "s", v: "很远" };
  const info = clampSheetRange(XLSX.utils, ws);
  ok(info.truncated, "超出行上限时标记截断");
  ok(ws["!ref"] === `A1:A${SHEET_VIEW_MAX_ROWS}`, `范围被硬上限截住（实际 ${ws["!ref"]}）`);
}

// 4. 真实文件字节往返（DocView 同款：默认稀疏模式读取）
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["甲", "乙"], ["1", "2"]]), "表");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const reread = XLSX.read(buf, { type: "array" });
  const ws = reread.Sheets["表"];
  clampSheetRange(XLSX.utils, ws);
  ok(ws["!ref"] === "A1:B2", `文件字节往返收敛正确（实际 ${ws["!ref"]}）`);
  ok(XLSX.utils.sheet_to_html(ws).includes("甲"), "往返收敛后渲染正常");
}

// 4b. xlsx@0.18.5 误传 dense 会产生数字行键结构：clamp 应免疫（不动 !ref、不崩溃）
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["甲", "乙"], ["1", "2"]]), "表");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const reread = XLSX.read(buf, { type: "array", dense: true });
  const ws = reread.Sheets["表"];
  const before = ws["!ref"];
  const info = clampSheetRange(XLSX.utils, ws);
  ok(ws["!ref"] === before && !info.truncated, `不可识别结构时保持 !ref 原样（${before}）`);
  ok(XLSX.utils.sheet_to_html(ws).includes("2"), "该结构下渲染仍由 SheetJS 自身完成");
}

// 5. 空表
{
  const ws: Record<string, unknown> = {};
  const info = clampSheetRange(XLSX.utils, ws);
  ok((ws["!ref"] === "A1" || ws["!ref"] === "A1:A1") && !info.truncated, `空表不抛错（实际 ${ws["!ref"]}）`);
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过");
process.exit(failed ? 1 : 0);
