import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components";
import type { CanonicalQuestionType } from "@/lib/meeting/task-taxonomy";
import type { AdviseDisplayTarget } from "@/lib/meeting/manual-advise-display";
import { sameAdviseDisplayTarget } from "@/lib/meeting/manual-advise-display";
import type { ManualCorrectionMenu, ManualCorrectionMenuSelection } from "@/lib/meeting/focus-window";
import { Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface TypeCorrectionMenuActions {
  displayTarget: AdviseDisplayTarget;
  requestMenu(type: CanonicalQuestionType, displayTarget: AdviseDisplayTarget, signal?: AbortSignal): ManualCorrectionMenu | Promise<ManualCorrectionMenu>;
  onSelect(selection: ManualCorrectionMenuSelection): void | Promise<unknown>;
}

/** Holds only this open edit. Runtime owns option legality and revalidates the selection. */
export function TypeCorrectionMenuButton({
  correctedType, label, title, selected, className, displayTarget, requestMenu, onSelect,
}: TypeCorrectionMenuActions & {
  correctedType: CanonicalQuestionType;
  label: string;
  title: string;
  selected: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState<{ displayTarget: AdviseDisplayTarget; menu?: ManualCorrectionMenu; error?: string }>();
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const submitted = useRef(false);
  useEffect(() => () => pending.current?.abort(), []);
  const stale = Boolean(edit && !sameAdviseDisplayTarget(edit.displayTarget, displayTarget));

  const changeOpen = (next: boolean) => {
    pending.current?.abort();
    setOpen(next);
    if (!next) { setEdit(undefined); return; }
    const controller = new AbortController();
    pending.current = controller;
    submitted.current = false;
    setSubmitting(false);
    const originalDisplay = { ...displayTarget };
    setEdit({ displayTarget: originalDisplay });
    void Promise.resolve().then(() => requestMenu(correctedType, originalDisplay, controller.signal))
      .then(menu => {
        if (menu.correctedType !== correctedType || (menu.target &&
            (menu.target.sessionId !== originalDisplay.sessionId ||
              (originalDisplay.logicalQuestionUnitId !== undefined &&
                (menu.target.logicalQuestionUnitId !== originalDisplay.logicalQuestionUnitId ||
                 menu.target.logicalQuestionRevision !== originalDisplay.logicalQuestionRevision))))) {
          throw new Error("The correction target changed. Reopen the type menu.");
        }
        if (!controller.signal.aborted) setEdit({ displayTarget: originalDisplay, menu: structuredClone(menu) });
      }).catch(error => {
        if (!controller.signal.aborted) setEdit({ displayTarget: originalDisplay,
          error: error instanceof Error ? error.message : "Unable to load correction options." });
      });
  };
  const message = stale ? "The displayed question changed. Reopen the type menu."
    : edit?.error ?? (edit?.menu?.rejectionReason
      ? `Correction unavailable: ${edit.menu.rejectionReason}. Reopen the type menu.` : undefined);

  return <Popover open={open} onOpenChange={changeOpen}>
    <PopoverTrigger asChild>
      <Button size="sm" variant={selected ? "default" : "outline"} className={className} title={title}>
        {label}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" side="top" collisionPadding={8}
      className="w-80 max-w-[calc(100vw-16px)] max-h-[min(360px,var(--radix-popover-content-available-height))] overflow-y-auto rounded-md p-2"
      aria-label={`${title} actions`}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold">
        <span className="min-w-0 break-words">{title}</span>
        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label="Cancel type correction" title="Cancel type correction"
          onClick={() => changeOpen(false)}><XIcon className="h-3.5 w-3.5" /></Button>
      </div>
      {message ? <p role="alert" className="break-words px-2 py-1 text-xs text-destructive">{message}</p>
        : !edit?.menu ? <div role="status" className="flex items-center gap-2 p-2 text-xs"><Loader2Icon className="h-3.5 w-3.5 animate-spin" />Loading options...</div>
          : !edit.menu.target || !edit.menu.options.length ? <p role="status" className="p-2 text-xs text-muted-foreground">No available action for this question.</p>
            : <div role="group" aria-label="Correction actions" className="flex flex-col gap-1">
              {edit.menu.options.map(option => <Button key={option.id} variant="ghost" size="sm"
                className="h-auto min-h-8 w-full justify-start whitespace-normal break-words px-2 py-2 text-left text-xs"
                disabled={submitting} onClick={() => {
                  if (submitted.current || stale || !edit.menu?.target) return;
                  submitted.current = true;
                  setSubmitting(true);
                  const signal = pending.current?.signal;
                  void Promise.resolve().then(() => onSelect({ correctedType, displayTarget: edit.displayTarget,
                    target: edit.menu!.target!, option })).then(() => {
                      if (!signal?.aborted) changeOpen(false);
                    }).catch(error => {
                      if (signal?.aborted) return;
                      setSubmitting(false);
                      setEdit(current => current ? { ...current, error: error instanceof Error ? error.message : "Correction failed. Reopen the type menu." } : current);
                    });
                }}>{option.label}</Button>)}
            </div>}
    </PopoverContent>
  </Popover>;
}
