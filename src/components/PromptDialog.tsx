import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useStore } from "@/store";

/** 通用单字段输入对话框（替代 window.prompt，Tauri webview 无原生 prompt） */
export default function PromptDialog() {
  const prompt = useStore((s) => s.prompt);
  const answerPrompt = useStore((s) => s.answerPrompt);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(prompt.value);
    if (prompt.open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [prompt.open, prompt.value]);

  const submit = () => {
    const v = value.trim();
    answerPrompt(v || null);
  };

  return (
    <Dialog
      open={prompt.open}
      onOpenChange={(o) => {
        if (!o) answerPrompt(null);
      }}
    >
      <DialogContent className="w-[min(440px,92vw)]">
        <DialogHeader>
          <DialogTitle>{prompt.title}</DialogTitle>
        </DialogHeader>
        {prompt.label && <p className="-mt-2 text-[12.5px] text-muted-foreground">{prompt.label}</p>}
        <Input
          ref={inputRef}
          value={value}
          placeholder={prompt.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter>
          <button
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => answerPrompt(null)}
          >
            取消
          </button>
          <button
            className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90"
            onClick={submit}
          >
            确定
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
