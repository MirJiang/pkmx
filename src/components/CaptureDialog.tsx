import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStore } from "@/store";
import { STATUS_LABEL } from "@/lib/types";

export default function CaptureDialog() {
  const open = useStore((s) => s.captureOpen);
  const captureStatus = useStore((s) => s.captureStatus);
  const setCaptureOpen = useStore((s) => s.setCaptureOpen);
  const capture = useStore((s) => s.capture);
  const defaultFolder = useStore((s) => s.defaultFolder);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const submit = (asTask: boolean) => {
    const t = value.trim();
    if (!t) return;
    capture(t, asTask);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => setCaptureOpen(o)}>
      <DialogContent className="w-[min(560px,92vw)] gap-0 p-1.5">
        <DialogHeader className="sr-only">
          <DialogTitle>快速捕获</DialogTitle>
          <DialogDescription>一句话记下，保存到默认文档地址</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2.5 px-3.5 py-3">
          <span
            className="size-[9px] shrink-0 animate-pulse rounded-[50%_50%_50%_2px] bg-primary"
            style={{ transform: "rotate(45deg)" }}
          />
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit(true);
              }
            }}
            placeholder={
              captureStatus
                ? `一句话记下…（回车转为「${STATUS_LABEL[captureStatus]}」任务）`
                : "一句话记下…（回车存为待办便签）"
            }
            className="flex-1 border-none bg-transparent font-serif text-base outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center gap-2 border-t border-border/70 px-3.5 py-2.5">
          <span className="font-mono text-[10.5px] text-muted-foreground">
            保存到 <b className="text-primary">{defaultFolder || "根目录"}</b> · 之后整理
          </span>
          <div className="ml-auto flex gap-1.5">
            <button
              className="rounded-lg border border-border px-3 py-[5px] text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              onClick={() => submit(false)}
            >
              存为普通笔记
            </button>
            <button
              className="rounded-lg bg-primary px-3 py-[5px] text-xs text-primary-foreground transition-opacity hover:opacity-90"
              onClick={() => submit(true)}
            >
              存为便签 ⏎
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
