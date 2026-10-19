/**
 * 多仓库统一图谱布局测试：node --experimental-strip-types scripts/test-graph.ts
 * 覆盖：同名双链本仓库优先解析、跨仓库边标记、簇布局分离度、孤立节点过滤、单仓库圆环回归。
 */
import { buildGraph, linkedIds } from "../src/lib/graph.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const A1 = { id: "a1", title: "甲笔记", body: "链接 [[共享名]] 与 [[乙独有]]", folder: "", fileName: "a1.md" };
const A2 = { id: "a2", title: "共享名", body: "主仓库同名", folder: "", fileName: "a2.md" };
const A3 = { id: "a3", title: "孤立笔记", body: "没有任何链接", folder: "", fileName: "a3.md" };
const B1 = {
  id: "vaultB::b1", title: "共享名", body: "b 仓库同名", folder: "vaultB", fileName: "b1.md",
  vaultRoot: "D:/tmp/vaultB", vaultName: "vaultB", rel: "b1.md",
};
const B2 = {
  id: "vaultB::b2", title: "乙独有", body: "看 [[共享名]]", folder: "vaultB", fileName: "b2.md",
  vaultRoot: "D:/tmp/vaultB", vaultName: "vaultB", rel: "b2.md",
};

console.log("== 多仓库：解析与边 ==");
const g = buildGraph([A1, A2, A3, B1, B2], "主仓");
assert(g.vaults.filter((v) => v.count > 0).length === 2, "识别出 2 个仓库");
const edge = (from: string, to: string) => g.edges.find((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
assert(edge("a1", "a2") !== undefined, "甲笔记→共享名 解析到主仓库 A2（本仓库优先）");
assert(edge("a1", "a2")?.crossVault === false, "该边不是跨仓库边");
assert(edge("vaultB::b2", "vaultB::b1") !== undefined, "乙独有→共享名 解析到 b 仓库 B1（本仓库优先）");
assert(edge("a1", "vaultB::b2")?.crossVault === true, "甲笔记→乙独有 标记为跨仓库边");
assert(g.edges.length === 3, `共 3 条边（实际 ${g.edges.length}）`);

console.log("== 多仓库：簇布局 ==");
const dist = (x1: number, y1: number, x2: number, y2: number) => Math.hypot(x1 - x2, y1 - y2);
const na1 = g.nodes.find((n) => n.id === "a1")!;
const nb1 = g.nodes.find((n) => n.id === "vaultB::b1")!;
const intraVault = dist(na1.x, na1.y, nb1.x, nb1.y);
assert(intraVault > 300, `两仓库簇心分离（距离 ${Math.round(intraVault)} > 300）`);
for (const n of g.nodes) {
  assert(n.x > 0 && n.x < 1200 && n.y > 0 && n.y < 760, `节点 ${n.id} 在画布内 (${Math.round(n.x)},${Math.round(n.y)})`);
}
assert(g.nodes.every((n) => (n.id.startsWith("vaultB") ? n.vaultIdx === 1 : n.vaultIdx === 0)), "vaultIdx 正确");

console.log("== 孤立节点 ==");
const linked = linkedIds(g.edges);
assert(!linked.has("a3"), "孤立笔记 a3 不在链接集合");
assert(linked.size === 4, "链接集合 4 个节点");
const degA1 = g.nodes.find((n) => n.id === "a1")!.degree;
assert(degA1 === 2, `甲笔记度数 2（实际 ${degA1}）`);

console.log("== 单仓库回归（圆环） ==");
const single = buildGraph([A1, A2, A3]);
assert(single.vaults.length === 1 && single.vaults[0].name === "主仓库", "单仓库 vaults=1");
assert(single.nodes.length === 3, "3 个节点");
assert(single.edges.length === 1, "1 条边（甲笔记→共享名）");

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log("\n全部通过");
