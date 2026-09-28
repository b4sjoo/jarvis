import { Button, Popover, PopoverContent, PopoverTrigger } from "@/components";
import { sameAdviseDisplayTarget } from "@/lib/meeting/manual-advise-display";
import type { ClarifyingSelectionLifecycleState } from "@/lib/meeting/types";
import type { ProjectChoicePresentation, ProjectChoiceSelection } from "@/lib/meeting/focus-window";
import { CheckIcon, Loader2Icon, PencilIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

/** The caller supplies owner-validated capabilities; this component never infers project authority. */
export function ProjectChoiceControl({ presentation, selectionState, selectionMessage, selectedLabel, onSelect }: {
  presentation?: ProjectChoicePresentation;
  selectionState?: ClarifyingSelectionLifecycleState;
  selectionMessage?: string;
  selectedLabel?: string;
  onSelect(selection: ProjectChoiceSelection): void;
}) {
  const [edit, setEdit] = useState<ProjectChoicePresentation>();
  const submitted = useRef(false);
  const pending = selectionState === "pending";
  if (!presentation || (!presentation.currentProject && (!presentation.canSelect || !presentation.options.length))) return null;
  const currentProjectId = presentation.currentProject?.id;
  const retryOption = selectionState === "failed" && currentProjectId
    ? presentation.options.find(option => option.value === currentProjectId)
    : undefined;
  const stale = Boolean(edit && (edit.key !== presentation.key ||
    edit.currentProject?.id !== presentation.currentProject?.id ||
    !sameAdviseDisplayTarget(edit.displayTarget, presentation.displayTarget)));
  const choices = (source: ProjectChoicePresentation, reselect: boolean) => <div role="group" aria-label="Project choices" className="flex flex-wrap gap-1.5">
    {source.options.map(option => <Button key={option.id} variant="outline" size="sm"
      className="h-auto min-h-7 max-w-full whitespace-normal break-words px-2 py-1 text-xs"
      disabled={pending || stale} onClick={() => {
        if (pending || stale || (reselect && submitted.current)) return;
        if (reselect) submitted.current = true;
        onSelect({ key: source.key, displayTarget: { ...source.displayTarget }, option, reselect });
        if (reselect) setEdit(undefined);
      }}>{option.label}</Button>)}
  </div>;
  return <div className="min-w-0 space-y-2" data-project-choice>
    <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
      <span className="min-w-0 break-words">{presentation.currentProject ? `Project: ${presentation.currentProject.name}` : "Choose project"}</span>
      {presentation.currentProject && presentation.canReselect && presentation.options.length > 0 ? <Popover open={Boolean(edit)} onOpenChange={open => {
        submitted.current = false;
        setEdit(open ? structuredClone(presentation) : undefined);
      }}>
        <PopoverTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7 shrink-0"
          title="Change project" aria-label="Change project" disabled={pending}><PencilIcon className="h-3.5 w-3.5" /></Button></PopoverTrigger>
        <PopoverContent align="start" className="w-80 max-w-[calc(100vw-16px)] rounded-md p-2">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold">
            <span>Change project</span><Button size="icon" variant="ghost" className="h-6 w-6" title="Cancel project change" aria-label="Cancel project change"
              onClick={() => setEdit(undefined)}><XIcon className="h-3.5 w-3.5" /></Button>
          </div>
          {stale ? <p role="alert" className="break-words text-xs text-destructive">The project selection changed. Reopen the project menu.</p>
            : edit ? choices(edit, true) : null}
        </PopoverContent>
      </Popover> : null}
      {retryOption ? <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0"
        title="Retry project answer" aria-label="Retry project answer"
        onClick={() => onSelect({ key: presentation.key, displayTarget: { ...presentation.displayTarget },
          option: retryOption, reselect: false })}><RefreshCwIcon className="h-3.5 w-3.5" /></Button> : null}
    </div>
    {presentation.canSelect && !presentation.currentProject ? choices(presentation, false) : null}
    {selectedLabel && selectionState ? <div role="status" className="flex min-w-0 items-start gap-1 text-xs text-muted-foreground">
      {pending ? <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin" /> : selectionState === "succeeded" ? <CheckIcon className="h-3.5 w-3.5 shrink-0" /> : null}
      <span className="min-w-0 break-words">{selectionMessage ?? `${selectedLabel}: ${selectionState}`}</span>
    </div> : null}
  </div>;
}
