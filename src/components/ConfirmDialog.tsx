import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";

/** 危险操作确认（删除本地文件等）：窗口正中弹出，Enter 确认 / Esc 取消 */
export default function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const answerConfirm = useStore((s) => s.answerConfirm);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm.open) requestAnimationFrame(() => okRef.current?.focus());
  }, [confirm.open]);

  return (
    <Dialog open={confirm.open} onOpenChange={(o) => !o && answerConfirm(false)}>
      <DialogContent className="w-[min(400px,92vw)]" onKeyDown={(e) => e.key === "Enter" && answerConfirm(true)}>
        <DialogHeader>
          <DialogTitle>{confirm.title}</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{confirm.message}</p>
        <div className="mt-1 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border px-3.5 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => answerConfirm(false)}
          >
            取消
          </button>
          <button
            ref={okRef}
            className={cn(
              "rounded-lg bg-primary px-3.5 py-1.5 text-xs text-primary-foreground transition-opacity hover:opacity-90",
              confirm.danger && "bg-st-blocked text-white",
            )}
            onClick={() => answerConfirm(true)}
          >
            {confirm.okLabel ?? "确认"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
