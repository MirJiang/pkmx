import type { Note } from "./types";

/**
 * 多仓库统一图谱的数据与布局（纯函数，便于独立测试）。
 * 单仓库 = 圆环布局；多仓库 = 每仓库一个簇（簇心均匀分布在画布圆周上，
 * 簇内节点绕簇心排布），跨仓库双链用虚线、节点外环用仓库色区分。
 */

/** 仓库环颜色（主仓库固定用第一种） */
export const VAULT_PALETTE = ["#7c8bc9", "#4da97f", "#c9903c", "#a874c9", "#c96f74", "#54b0bd", "#8a9a4d"];

export interface GraphNode {
  note: Note;
  id: string;
  x: number;
  y: number;
  vaultIdx: number; // 仓库序号（0 = 主仓库）
  vaultName: string;
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  crossVault: boolean;
}

export interface VaultInfo {
  name: string;
  color: string;
  count: number;
  primary: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  vaults: VaultInfo[];
}

const vaultKey = (n: Note): string => (n.vaultRoot ? n.vaultName ?? "?" : "");

/** 双链解析：[[名字]] 同名笔记优先本仓库，其次全局（与编辑器点击行为一致） */
function buildEdges(notes: Note[]): GraphEdge[] {
  const perVault = new Map<string, Map<string, Note>>();
  const global = new Map<string, Note>();
  for (const n of notes) {
    const v = vaultKey(n);
    if (!perVault.has(v)) perVault.set(v, new Map());
    perVault.get(v)!.set(n.title, n);
    if (!global.has(n.title)) global.set(n.title, n);
  }
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const n of notes) {
    for (const m of n.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const name = m[1].trim();
      const target = perVault.get(vaultKey(n))?.get(name) ?? global.get(name);
      if (!target || target.id === n.id) continue;
      const key = n.id < target.id ? `${n.id}\u0000${target.id}` : `${target.id}\u0000${n.id}`;
      if (seen.has(key)) continue; // 同一对笔记的多条链接只画一条
      seen.add(key);
      edges.push({ from: n.id, to: target.id, crossVault: vaultKey(n) !== vaultKey(target) });
    }
  }
  return edges;
}

export function buildGraph(notes: Note[], primaryName = "主仓库", W = 1200, H = 760): GraphData {
  const edges = buildEdges(notes);
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // 仓库分组：主仓库在前，其余按加载出现顺序
  const extraNames: string[] = [];
  for (const n of notes) {
    const v = vaultKey(n);
    if (v && !extraNames.includes(v)) extraNames.push(v);
  }
  const groups: Note[][] = [notes.filter((n) => !vaultKey(n))];
  for (const name of extraNames) groups.push(notes.filter((n) => vaultKey(n) === name));
  const vaults: VaultInfo[] = groups
    .map((g, i) => ({
      name: i === 0 ? primaryName : extraNames[i - 1],
      color: VAULT_PALETTE[i % VAULT_PALETTE.length],
      count: g.length,
      primary: i === 0,
    }))
    .filter((_, i) => groups[i].length > 0 || i === 0);

  const cx = W / 2;
  const cy = H / 2;
  const nodes: GraphNode[] = [];
  const vaultIdxOf = new Map(groups.map((g, i) => [g.length ? vaultKey(g[0]) : "", i]));

  const multi = groups.filter((g) => g.length > 0).length > 1;
  if (!multi) {
    // 单仓库：圆环
    const g = groups[0];
    const R = Math.min(W, H) / 2 - 110;
    g.forEach((n, i) => {
      const a = (i / Math.max(1, g.length)) * Math.PI * 2 - Math.PI / 2;
      nodes.push({
        note: n,
        id: n.id,
        x: cx + R * Math.cos(a),
        y: cy + R * Math.sin(a),
        vaultIdx: 0,
        vaultName: vaults[0]?.name ?? primaryName,
        degree: degree.get(n.id) ?? 0,
      });
    });
  } else {
    // 多仓库：簇布局
    const active = groups.filter((g) => g.length > 0);
    const radii = active.map((g) => Math.min(120, Math.max(56, 46 + 13 * Math.sqrt(g.length))));
    const maxR = Math.max(...radii);
    const Rc = Math.min(W, H) / 2 - 34 - maxR;
    active.forEach((g, k) => {
      const idx = vaultIdxOf.get(vaultKey(g[0])) ?? k;
      const theta = -Math.PI / 2 + (k / active.length) * Math.PI * 2;
      const ccx = cx + Rc * Math.cos(theta);
      const ccy = cy + Rc * Math.sin(theta);
      const r = radii[k];
      g.forEach((n, i) => {
        const a = (i / Math.max(1, g.length)) * Math.PI * 2 - Math.PI / 2;
        nodes.push({
          note: n,
          id: n.id,
          x: ccx + r * Math.cos(a),
          y: ccy + r * Math.sin(a),
          vaultIdx: idx,
          vaultName: vaults[idx]?.name ?? "",
          degree: degree.get(n.id) ?? 0,
        });
      });
    });
  }

  return { nodes, edges, vaults };
}

/** 有连边的节点 id 集合（隐藏孤立节点开关用） */
export function linkedIds(edges: GraphEdge[]): Set<string> {
  const s = new Set<string>();
  for (const e of edges) {
    s.add(e.from);
    s.add(e.to);
  }
  return s;
}
