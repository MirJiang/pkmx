import { useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { useStore, searchVaults } from "@/store";
import { StatusChip } from "./Chips";

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-primary/20 px-0.5 text-primary">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length, idx + q.length + 60)}
    </>
  );
}

/** 全文搜索：桌面模式走 Rust 侧扫描（主仓库+同时加载仓库），浏览器回退前端过滤 */
export default function SearchView() {
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [fsResults, setFsResults] = useState<{ note: (typeof notes)[number]; snippet: string }[] | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 桌面模式：300ms 去抖调 Rust 搜索
  useEffect(() => {
    const query = q.trim();
    if (!query) {
      setFsResults(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      const r = await searchVaults(query);
      if (alive) setFsResults(r);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const localResults = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query || fsResults !== null) return [];
    return notes
      .filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(query))
      .slice(0, 50)
      .map((n) => {
        const line = n.body.split("\n").find((l) => l.toLowerCase().includes(query)) ?? "";
        return { note: n, snippet: line.trim().slice(0, 120) };
      });
  }, [q, notes, fsResults]);

  const results = fsResults ?? localResults;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="mx-auto w-full max-w-[860px] px-10 pt-[30px]">
        <div className="mb-1 flex items-baseline gap-2.5">
          <h2 className="font-serif text-2xl font-bold">搜索</h2>
          {q && <span className="font-mono text-[11.5px] text-muted-foreground">{results.length} 个结果</span>}
        </div>
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 focus-within:border-primary">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="在所有已加载仓库的标题与正文中搜索…"
            className="flex-1 border-none bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[860px] flex-1 overflow-y-auto px-10 pb-[120px] pt-4">
        {results.map(({ note, snippet }) => (
          <button
            key={note.id}
            onClick={() => openNote(note.id)}
            className="mb-2 block w-full rounded-xl border border-border/70 bg-card px-4 py-3 text-left transition-colors hover:border-primary/40"
          >
            <div className="mb-1 flex items-center gap-2 text-sm font-medium">
              <FileText size={13} strokeWidth={1.3} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{note.title}</span>
              {note.status && <StatusChip s={note.status} />}
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {note.vaultName ? `${note.vaultName}/` : ""}
                {note.fileName}
              </span>
            </div>
            <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">
              {snippet ? <Highlight text={snippet} query={q.trim()} /> : "（匹配在标题）"}
            </p>
          </button>
        ))}
        {!q && <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">输入关键词开始搜索。</p>}
        {q && !results.length && (
          <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">没有匹配的笔记。</p>
        )}
      </div>
    </section>
  );
}
