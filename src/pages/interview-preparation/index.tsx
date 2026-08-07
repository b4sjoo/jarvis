import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import { PageLayout } from "@/layouts";
import {
  formatRoundStage,
  INTERVIEW_ROUND_STAGES,
  interviewPreparationService,
  type InterviewProcess,
  type InterviewProcessDetail,
  type InterviewRoundStage,
} from "@/lib/preparation";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Circle,
  FileText,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";

type MobilePanel = "processes" | "conversation" | "review";

const InterviewPreparation = () => {
  const { processId } = useParams();
  const navigate = useNavigate();
  const [processes, setProcesses] = useState<InterviewProcess[]>([]);
  const [detail, setDetail] = useState<InterviewProcessDetail>();
  const [showArchived, setShowArchived] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [roundOpen, setRoundOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("processes");

  const loadProcesses = useCallback(async () => {
    const loaded = await interviewPreparationService.list(true);
    setProcesses(loaded);
  }, []);

  const loadDetail = useCallback(async (id: string | undefined) => {
    if (!id) {
      setDetail(undefined);
      return;
    }
    const loaded = await interviewPreparationService.get(id);
    setDetail(loaded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([loadProcesses(), loadDetail(processId)])
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadDetail, loadProcesses, processId]);

  const refresh = async (selectedId = processId) => {
    setError(undefined);
    try {
      await Promise.all([loadProcesses(), loadDetail(selectedId)]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const selectProcess = (id: string) => {
    navigate(`/interview-preparation/${id}`);
    setMobilePanel("conversation");
  };

  const handleArchive = async () => {
    if (!detail) return;
    try {
      await interviewPreparationService.archive(detail.process.id);
      await refresh(detail.process.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const handleReopen = async () => {
    if (!detail) return;
    try {
      await interviewPreparationService.reopen(detail.process.id);
      await refresh(detail.process.id);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    try {
      await interviewPreparationService.delete(detail.process.id);
      setDeleteOpen(false);
      navigate("/interview-preparation");
      await refresh(undefined);
      setMobilePanel("processes");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const visibleProcesses = processes.filter(
    (process) => (process.status === "archived") === showArchived
  );

  return (
    <PageLayout
      title="Interview Preparation"
      description="Processes, rounds, and reviewed preparation state"
      rightSlot={
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New process
        </Button>
      }
    >
      {error && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive border px-3 py-2 text-sm">
          {error}
        </div>
      )}

      <MobilePanelSelector value={mobilePanel} onChange={setMobilePanel} />

      <div className="grid min-h-[640px] overflow-hidden border lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        <section
          className={`border-r ${mobilePanel === "processes" ? "block" : "hidden"} lg:block`}
        >
          <div className="flex h-12 items-center justify-between border-b px-3">
            <span className="text-sm font-semibold">Processes</span>
            <div className="flex border">
              <FilterButton
                active={!showArchived}
                label="Active"
                onClick={() => setShowArchived(false)}
              />
              <FilterButton
                active={showArchived}
                label="Archived"
                onClick={() => setShowArchived(true)}
              />
            </div>
          </div>
          <div className="max-h-[588px] overflow-y-auto">
            {isLoading ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : visibleProcesses.length ? (
              visibleProcesses.map((process) => (
                <button
                  key={process.id}
                  className={`w-full border-b px-3 py-3 text-left transition-colors hover:bg-muted/60 ${process.id === processId ? "bg-muted" : ""}`}
                  onClick={() => selectProcess(process.id)}
                >
                  <div className="line-clamp-2 text-sm font-medium">
                    {process.title}
                  </div>
                  <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                    {[process.company, process.role].filter(Boolean).join(" · ") ||
                      "Unresolved company and role"}
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No {showArchived ? "archived" : "active"} processes
              </div>
            )}
          </div>
        </section>

        <section
          className={`${mobilePanel === "conversation" ? "block" : "hidden"} min-w-0 lg:block`}
        >
          {detail ? (
            <ProcessWorkspace
              detail={detail}
              onAddRound={() => setRoundOpen(true)}
              onSetActiveRound={async (roundId) => {
                try {
                  await interviewPreparationService.setActiveRound(
                    detail.process.id,
                    roundId
                  );
                  await refresh(detail.process.id);
                } catch (reason) {
                  setError(errorMessage(reason));
                }
              }}
              onArchive={handleArchive}
              onReopen={handleReopen}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : (
            <div className="flex min-h-[640px] items-center justify-center px-6 text-sm text-muted-foreground">
              Select an interview process
            </div>
          )}
        </section>

        <section
          className={`${mobilePanel === "review" ? "block" : "hidden"} border-l lg:block`}
        >
          <ReviewedStatePanel detail={detail} />
        </section>
      </div>

      <CreateProcessDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          setCreateOpen(false);
          setProcesses((current) => [created.process, ...current]);
          navigate(`/interview-preparation/${created.process.id}`);
          setMobilePanel("conversation");
        }}
      />
      <CreateRoundDialog
        processId={detail?.process.id}
        open={roundOpen}
        onOpenChange={setRoundOpen}
        onCreated={async () => {
          setRoundOpen(false);
          await refresh(detail?.process.id);
        }}
      />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete interview process?</DialogTitle>
            <DialogDescription>
              This removes its local preparation state and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 className="size-4" /> Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageLayout>
  );
};

const ProcessWorkspace = ({
  detail,
  onAddRound,
  onSetActiveRound,
  onArchive,
  onReopen,
  onDelete,
}: {
  detail: InterviewProcessDetail;
  onAddRound: () => void;
  onSetActiveRound: (roundId: string) => Promise<void>;
  onArchive: () => Promise<void>;
  onReopen: () => Promise<void>;
  onDelete: () => void;
}) => (
  <div className="flex min-h-[640px] flex-col">
    <div className="flex min-h-20 items-start justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold">{detail.process.title}</h2>
          <Badge variant="outline">{detail.process.status}</Badge>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {[detail.process.company, detail.process.role].filter(Boolean).join(" · ") ||
            "Company and role unresolved"}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {detail.process.status === "archived" ? (
          <Button size="icon" variant="outline" title="Reopen" onClick={onReopen}>
            <RotateCcw className="size-4" />
          </Button>
        ) : (
          <Button size="icon" variant="outline" title="Archive" onClick={onArchive}>
            <Archive className="size-4" />
          </Button>
        )}
        <Button size="icon" variant="outline" title="Delete" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>

    <div className="border-b">
      <div className="flex h-11 items-center justify-between px-4">
        <span className="text-sm font-semibold">Rounds</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onAddRound}
          disabled={detail.process.status === "archived"}
        >
          <Plus className="size-4" /> Round
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto border-t">
        {detail.rounds.map((round) => {
          const active = round.id === detail.process.activeRoundId;
          return (
            <button
              key={round.id}
              className="flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-muted/60 disabled:cursor-default"
              onClick={() => onSetActiveRound(round.id)}
              disabled={active || detail.process.status === "archived"}
            >
              {active ? (
                <CheckCircle2 className="size-4 shrink-0 text-primary" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{round.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatRoundStage(round.stage)}</span>
                  {round.scheduledAt && (
                    <span className="flex items-center gap-1">
                      <CalendarDays className="size-3" />
                      {new Date(round.scheduledAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <Badge variant="outline">{round.expectedTypePolicy}</Badge>
            </button>
          );
        })}
      </div>
    </div>

    <div className="flex flex-1 flex-col">
      <div className="flex h-11 items-center gap-2 border-b px-4 text-sm font-semibold">
        <MessageSquare className="size-4" /> Preparation Conversation
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No preparation messages
      </div>
    </div>
  </div>
);

const ReviewedStatePanel = ({ detail }: { detail?: InterviewProcessDetail }) => (
  <div className="min-h-[640px]">
    <div className="flex h-12 items-center justify-between border-b px-4">
      <span className="text-sm font-semibold">Reviewed State</span>
      <Badge variant="outline">Draft</Badge>
    </div>
    {detail ? (
      <div>
        {["Logistics", "Evidence", "Terminology", "Strategy"].map((label) => (
          <div key={label} className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm">{label}</span>
            <span className="text-xs text-muted-foreground">0</span>
          </div>
        ))}
        <div className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground">
          <FileText className="size-4" /> No reviewed items
        </div>
      </div>
    ) : (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        No active process
      </div>
    )}
  </div>
);

const CreateProcessDialog = ({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (detail: InterviewProcessDetail) => void;
}) => {
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [stage, setStage] = useState<InterviewRoundStage>("recruiter-screen");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setError(undefined);
    try {
      const created = await interviewPreparationService.create({
        title,
        company,
        role,
        initialRound: { stage },
      });
      setTitle("");
      setCompany("");
      setRole("");
      setStage("recruiter-screen");
      onCreated(created);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New interview process</DialogTitle>
            <DialogDescription>
              Company and role can remain unresolved.
            </DialogDescription>
          </DialogHeader>
          <Field label="Process title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company">
              <Input value={company} onChange={(event) => setCompany(event.target.value)} />
            </Field>
            <Field label="Role">
              <Input value={role} onChange={(event) => setRole(event.target.value)} />
            </Field>
          </div>
          <Field label="Initial round">
            <RoundStageSelect value={stage} onChange={setStage} />
          </Field>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || isSaving}>
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const CreateRoundDialog = ({
  processId,
  open,
  onOpenChange,
  onCreated,
}: {
  processId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) => {
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<InterviewRoundStage>("coding");
  const [scheduledAt, setScheduledAt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!processId) return;
    setIsSaving(true);
    setError(undefined);
    try {
      await interviewPreparationService.addRound(processId, {
        title,
        stage,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : undefined,
      });
      setTitle("");
      setScheduledAt("");
      await onCreated();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add interview round</DialogTitle>
          </DialogHeader>
          <Field label="Round title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Stage">
            <RoundStageSelect value={stage} onChange={setStage} />
          </Field>
          <Field label="Scheduled time">
            <Input
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </Field>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!processId || isSaving}>
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Add round
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const RoundStageSelect = ({
  value,
  onChange,
}: {
  value: InterviewRoundStage;
  onChange: (value: InterviewRoundStage) => void;
}) => (
  <Select value={value} onValueChange={(next) => onChange(next as InterviewRoundStage)}>
    <SelectTrigger className="w-full">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {INTERVIEW_ROUND_STAGES.map((stage) => (
        <SelectItem key={stage} value={stage}>
          {formatRoundStage(stage)}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="grid gap-1.5 text-sm">
    <span className="font-medium">{label}</span>
    {children}
  </label>
);

const MobilePanelSelector = ({
  value,
  onChange,
}: {
  value: MobilePanel;
  onChange: (value: MobilePanel) => void;
}) => (
  <div className="grid grid-cols-3 border lg:hidden">
    {([
      ["processes", "Processes"],
      ["conversation", "Workspace"],
      ["review", "Reviewed"],
    ] as const).map(([id, label]) => (
      <button
        key={id}
        className={`h-9 border-r text-xs last:border-r-0 ${value === id ? "bg-primary text-primary-foreground" : "bg-background"}`}
        onClick={() => onChange(id)}
      >
        {label}
      </button>
    ))}
  </div>
);

const FilterButton = ({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) => (
  <button
    className={`h-7 px-2 text-[11px] ${active ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}
    onClick={onClick}
  >
    {label}
  </button>
);

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export default InterviewPreparation;
