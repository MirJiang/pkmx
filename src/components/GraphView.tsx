import { useMemo, useState } from "react";
import { useStore, getVault } from "@/store";
import { STATUS_COLOR } from "@/lib/types";
import { buildGraph, linkedIds } from "@/lib/graph";

/** 图谱：多仓库统一可视化（按仓库分簇着色，跨仓库双链虚线，悬停高亮邻域） */
export default function GraphView() {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverVault, setHoverVault] = useState<number | null>(null);
  const [hideOrphan, setHideOrphan] = useState(false);

  const { nodes, edges, vaults, byId } = useMemo(() => {
    const data = buildGraph(notes, getVault().rootName);
    const byId = new Map<string, (typeof data.nodes)[number]>();
    for (const n of data.nodes) byId.set(n.id, n);
    return { ...data, byId };
  }, [notes]);

  const multi = vaults.filter((v) => v.count > 0).length > 1;
  const linked = useMemo(() => linkedIds(edges), [edges]);

  const neighborIds = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const e of edges) {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    }
    return set;
  }, [hover, edges]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2.5 px-[22px] pb-2 pt-4">
        <h2 className="font-serif text-[19px] font-bold">图谱</h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {notes.length} 篇 · {edges.length} 条双链
          {multi && ` · ${vaults.filter((v) => v.count > 0).length} 个仓库`}
        </span>
        {/* 仓库图例：多仓库时展示簇色；悬停图例聚焦该仓库 */}
        {multi && (
          <div className="flex items-center gap-1.5">
            {vaults
              .filter((v) => v.count > 0)
              .map((v) => {
                const idx = vaults.indexOf(v);
                return (
                  <button
                    key={v.name}
                    className={`flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-opacity hover:text-foreground ${
                      hoverVault !== null && hoverVault !== idx ? "opacity-40" : ""
                    }`}
                    onMouseEnter={() => setHoverVault(idx)}
                    onMouseLeave={() => setHoverVault(null)}
                    title={v.primary ? "主仓库" : "同时加载的仓库"}
                  >
                    <span className="size-[8px] rounded-full" style={{ background: v.color }} />
                    {v.name} · {v.count}
                  </button>
                );
              })}
          </div>
        )}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
          <input type="checkbox" checked={hideOrphan} onChange={(e) => setHideOrphan(e.target.checked)} className="accent-primary" />
          隐藏孤立笔记
        </label>
        <span className="font-mono text-[10.5px] text-muted-foreground">悬停高亮邻域 · 点击打开笔记</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-6">
        <svg viewBox="0 0 1200 760" className="h-full w-full">
          {edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const active = !hover || e.from === hover || e.to === hover;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={active ? (e.crossVault ? vaults[a.vaultIdx]?.color ?? "var(--primary)" : "var(--primary)") : "var(--border)"}
                strokeWidth={active ? (e.crossVault ? 1.4 : 1.2) : 0.7}
                strokeDasharray={e.crossVault ? "5 4" : undefined}
                opacity={active ? 0.85 : 0.35}
              />
            );
          })}
          {nodes.map((n) => {
            if (hideOrphan && !linked.has(n.id)) return null;
            const dim = neighborIds ? !neighborIds.has(n.id) : hoverVault !== null && n.vaultIdx !== hoverVault;
            const color = n.note.status ? STATUS_COLOR[n.note.status] : "var(--muted-foreground)";
            const r = 7 + Math.min(3, n.degree * 0.5);
            return (
              <g
                key={n.id}
                opacity={dim ? 0.22 : 1}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => openNote(n.id)}
                className="cursor-pointer"
              >
                <title>{`${n.note.title} · ${n.vaultName}${n.degree ? ` · ${n.degree} 条链接` : ""}`}</title>
                {multi && (
                  <circle cx={n.x} cy={n.y} r={r + 2.5} fill="none" stroke={vaults[n.vaultIdx]?.color} strokeWidth={1.6} />
                )}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={hover === n.id ? r + 2 : r}
                  fill={color}
                  stroke="var(--background)"
                  strokeWidth={2}
                />
                <text
                  x={n.x}
                  y={n.y - (multi ? r + 10 : 13)}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill="var(--muted-foreground)"
                  style={{ paintOrder: "stroke", stroke: "var(--background)", strokeWidth: 3 }}
                >
                  {n.note.title.length > 10 ? n.note.title.slice(0, 10) + "…" : n.note.title}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
