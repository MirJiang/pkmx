/**
 * xlsx/xls 渲染管线实测（DocView 用的同一条转换路径）：
 * 生成真实 .xlsx / .xls → 读回字节 → XLSX.read → clampSheetRange → sheet_to_html → 断言内容。
 * 运行：node --experimental-strip-types scripts/test-office.mjs（导入 office.ts 需要）
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
const { clampSheetRange } = await import("../src/lib/office.ts");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
};

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([
  ["项目", "进度", "负责人"],
  ["块编辑", 1.0, "张三"],
  ["tantivy", 0.9, "李四"],
]);
XLSX.utils.book_append_sheet(wb, ws, "进度表");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["第二页"]]), "汇总");

const dir = mkdtempSync(join(tmpdir(), "pkmx-xlsx-"));
const file = join(dir, "测试表格.xlsx");
XLSX.writeFile(wb, file);

// —— DocView 同款路径：字节 → read(array) → clamp → sheet_to_html
const bytes = require("node:fs").readFileSync(file);
const reread = XLSX.read(bytes, { type: "array" });
for (const name of reread.SheetNames) clampSheetRange(XLSX.utils, reread.Sheets[name]);
ok(reread.SheetNames.length === 2, "多工作表识别（进度表/汇总）");
const html = XLSX.utils.sheet_to_html(reread.Sheets["进度表"]);
ok(html.includes("块编辑") && html.includes("tantivy"), "sheet_to_html 含单元格内容");
ok(html.includes("<table"), "输出为 HTML 表格");
ok(/进度表|汇总/.test(reread.SheetNames.join(",")), "中文表名正常");

// —— xls（BIFF8 二进制）同管线：write biff8 → 读回字节 → read 自动识别 → clamp → sheet_to_html
const xlsFile = join(dir, "旧格式表格.xls");
XLSX.writeFile(wb, xlsFile, { bookType: "biff8" });
const xlsBytes = require("node:fs").readFileSync(xlsFile);
const xlsRead = XLSX.read(xlsBytes, { type: "array" });
ok(xlsRead.SheetNames.length >= 1, `xls 多工作表识别（实际 ${xlsRead.SheetNames.join(",")}）`);
for (const name of xlsRead.SheetNames) clampSheetRange(XLSX.utils, xlsRead.Sheets[name]);
const xlsHtml = XLSX.utils.sheet_to_html(xlsRead.Sheets[xlsRead.SheetNames[0]]);
ok(xlsHtml.includes("块编辑") && xlsHtml.includes("tantivy"), "xls：收敛 + sheet_to_html 含单元格内容");
ok(xlsHtml.includes("<table"), "xls：输出为 HTML 表格");

rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
