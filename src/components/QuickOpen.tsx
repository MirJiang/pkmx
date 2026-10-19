import { useState } from "react";
import { FileText } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStore } from "@/store";

export default function QuickOpen() {
  const open = useStore((s) => s.quickOpenOpen);
  const setQuickOpenOpen = useStore((s) => s.setQuickOpenOpen);
  const notes = useStore((s) => s.notes);
  const openNote = useStore((s) => s.openNote);
  const openOrCreateByTitle = useStore((s) => s.openOrCreateByTitle);
  const [query, setQuery] = useState("");

  const go = (id: string) => {
    openNote(id);
    setQuickOpenOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setQuickOpenOpen}>
      <DialogContent className="w-[min(600px,92vw)] gap-0 overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>快速打开</DialogTitle>
          <DialogDescription>按标题或文件名模糊跳转</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={true} onValueChange={(v) => setQuery(typeof v === "string" ? v : "")}>
          <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3.5">
            <CommandInput
              placeholder="按标题或文件名模糊跳转…（无匹配时回车创建）"
              className="flex-1 border-none bg-transparent text-[15px] shadow-none focus-visible:ring-0 [&>div]:border-0 [&>input]:placeholder:text-muted-foreground"
              onValueChange={setQuery}
            />
          </div>
          <CommandList className="max-h-[340px] p-2">
            <CommandEmpty>
              <button
                className="mx-auto block rounded-md px-3 py-1.5 text-[13px] text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  if (query.trim()) {
                    openOrCreateByTitle(query.trim());
                    setQuickOpenOpen(false);
                  }
                }}
              >
                没有" {query} "的匹配 — 回车创建新笔记
              </button>
            </CommandEmpty>
            {notes.map((n) => (
              <CommandItem
                key={n.id}
                value={`${n.title} ${n.fileName}`}
                onSelect={() => go(n.id)}
                className="flex items-center gap-2.5"
              >
                <FileText size={13} strokeWidth={1.3} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{n.title}</span>
                <span className="ml-auto max-w-[200px] truncate font-mono text-[10px] text-muted-foreground">
                  {n.fileName}
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
