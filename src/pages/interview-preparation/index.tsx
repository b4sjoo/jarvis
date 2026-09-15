import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Header,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components";
import {
  buildRoundTimeOptions,
  formatRoundStage,
  formatRoundStageLabel,
  INTERVIEW_ROUND_STAGES,
  PREPARATION_EXPECTED_INTERVIEW_TYPES,
  interviewPreparationSnapshotService,
  interviewPreparationService,
  type InterviewProcess,
  type InterviewProcessDetail,
  type InterviewRound,
  type InterviewRoundStage,
  type PreparationExpectedInterviewType,
  type PreparationCurrentContext,
  localRoundScheduleToTimestamp,
  type PreparationMaterial,
  timestampToLocalRoundSchedule,
} from "@/lib/preparation";
import {
  Archive,
  CalendarDays,
  CheckCircle2,
  Circle,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Check,
  Crosshair,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MaterialPanel } from "./components/MaterialPanel";
import { PreparationConversationPanel } from "./components/PreparationConversationPanel";
import { ReviewedPreparationPanel } from "./components/ReviewedPreparationPanel";
import { usePreparationData, type PreparationData } from "./usePreparationData";
import { usePageOperation } from "./page-resource";

type MobilePanel = "processes" | "conversation" | "review";
type ExpandedWorkspaceSurface = "conversation" | "review";

const InterviewPreparation = () => {
  const { processId } = useParams();
  const navigate = useNavigate();
  const data = usePreparationData(processId);
  const processes = data.processes.data ?? [];
  const detail = data.detail.data;
  const materials = data.materials.data ?? [];
  const currentContext = data.currentContext.data ?? { revision: 0, updatedAt: 0 };
  const isLoading = data.processes.loading;
  const { error, notice, onError: setError, onNotice: setNotice } = data;
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [processEditOpen, setProcessEditOpen] = useState(false);
  const [roundOpen, setRoundOpen] = useState(false);
  const [roundEditTarget, setRoundEditTarget] = useState<InterviewRound>();
  const [roundDeleteTarget, setRoundDeleteTarget] = useState<InterviewRound>();
  const [isDeletingRound, setIsDeletingRound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("processes");
  const [expandedWorkspaceSurface, setExpandedWorkspaceSurface] =
    useState<ExpandedWorkspaceSurface>();
  const [currentRoundTarget, setCurrentRoundTarget] = useState<InterviewRound>();
  const processOperation = usePageOperation(JSON.stringify([processId]));
  const roundDeletionOperation = usePageOperation(JSON.stringify([processId, roundDeleteTarget?.id]));
  const activeRoundOperation = usePageOperation(JSON.stringify([processId]));
  const currentContextOperation = usePageOperation(JSON.stringify([processId, currentRoundTarget?.id]));

  const handleWorkspaceMaterialsChanged = data.refreshMaterials;
  const handleWorkspaceError = data.onError;
  const handleWorkspaceNotice = data.onNotice;

  useEffect(() => {
    setProcessEditOpen(false);
    setRoundEditTarget(undefined);
    setRoundDeleteTarget(undefined);
    setIsDeletingRound(false);
    setRoundOpen(false);
    setDeleteOpen(false);
    setCurrentRoundTarget(undefined);
    setExpandedWorkspaceSurface(undefined);
  }, [processId]);
  const refresh = data.refreshProcess;

  const selectProcess = (id: string) => {
    navigate(`/interview-preparation/${id}`);
    setMobilePanel("conversation");
  };

  const handleConversationDetailChange = useCallback((open: boolean) => {
    setExpandedWorkspaceSurface((current) =>
      open ? "conversation" : current === "conversation" ? undefined : current
    );
  }, []);

  const handleReviewedStateExpandedChange = useCallback((expanded: boolean) => {
    setExpandedWorkspaceSurface((current) =>
      expanded ? "review" : current === "review" ? undefined : current
    );
  }, []);

  const handleArchive = async () => {
    if (!detail) return;
    const owns = processOperation.begin();
    try {
      await interviewPreparationService.archive(detail.process.id);
      await refresh(detail.process.id);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    }
  };

  const handleReopen = async () => {
    if (!detail) return;
    const owns = processOperation.begin();
    try {
      await interviewPreparationService.reopen(detail.process.id);
      await refresh(detail.process.id);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    }
  };

  const handleDelete = async () => {
    if (!detail) return;
    const owns = processOperation.begin();
    try {
      await interviewPreparationService.delete(detail.process.id);
      await refresh(detail.process.id, false);
      if (!owns()) return;
      setDeleteOpen(false);
      navigate("/interview-preparation");
      setMobilePanel("processes");
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    }
  };

  const handleDeleteRound = async () => {
    if (!detail || !roundDeleteTarget) return;
    const owns = roundDeletionOperation.begin();
    setIsDeletingRound(true);
    setError("");
    try {
      const result = await interviewPreparationService.deleteRound(
        detail.process.id,
        roundDeleteTarget.id
      );
      await refresh(detail.process.id);
      if (!owns()) return;
      setRoundDeleteTarget(undefined);
      setNotice(
        `${roundDeleteTarget.title} deleted · ${result.deletedMaterialCount} materials removed`
      );
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    } finally {
      if (owns()) setIsDeletingRound(false);
    }
  };

  const visibleProcesses = processes.filter(
    (process) => (process.status === "archived") === showArchived
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden px-1 pb-4 pt-8" data-preparation-workspace>
      <Header
        isMainTitle
        showBorder
        className="shrink-0 gap-2 [&>div]:min-w-0"
        title="Interview Preparation"
        description="Processes, rounds, and reviewed preparation state"
        rightSlot={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New process
          </Button>
        }
      />
      {error && (
        <div className="max-h-20 shrink-0 overflow-y-auto border-destructive/30 bg-destructive/10 text-destructive border px-3 py-2 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="max-h-20 shrink-0 overflow-y-auto border bg-muted px-3 py-2 text-sm">{notice}</div>
      )}

      {!expandedWorkspaceSurface && (
        <MobilePanelSelector value={mobilePanel} onChange={setMobilePanel} />
      )}

      <div
        className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden border ${
          expandedWorkspaceSurface
            ? "grid-cols-1"
            : "lg:grid-cols-[220px_minmax(0,1fr)] 2xl:grid-cols-[260px_minmax(0,1fr)_380px]"
        }`}
      >
        <section
          className={
            expandedWorkspaceSurface
              ? "hidden"
              : `min-h-0 flex-col border-r ${mobilePanel === "processes" ? "flex" : "hidden"} lg:flex`
          }
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
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
          <div className="min-h-0 flex-1 overflow-y-auto">
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
                  {currentContext.processId === process.id && (
                    <Badge className="mt-1 rounded-sm text-[10px]">Current</Badge>
                  )}
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
          className={
            expandedWorkspaceSurface === "review"
              ? "hidden"
              : expandedWorkspaceSurface === "conversation"
                ? "block min-h-0 min-w-0"
                : mobilePanel === "review"
                  ? "hidden min-h-0 min-w-0 2xl:block"
                  : `${mobilePanel === "conversation" ? "block" : "hidden"} min-h-0 min-w-0 lg:block`
          }
        >
          {detail ? (
            <ProcessWorkspace
              data={data}
              detail={detail}
              currentContext={currentContext}
              materials={materials}
              onMaterialsChanged={handleWorkspaceMaterialsChanged}
              onError={handleWorkspaceError}
              onNotice={handleWorkspaceNotice}
              conversationExpanded={
                expandedWorkspaceSurface === "conversation"
              }
              onConversationDetailChange={handleConversationDetailChange}
              onAddRound={() => setRoundOpen(true)}
              onEditProcess={() => setProcessEditOpen(true)}
              onEditRound={setRoundEditTarget}
              onDeleteRound={setRoundDeleteTarget}
              onSetActiveRound={async (roundId) => {
                const owns = activeRoundOperation.begin();
                try {
                  await interviewPreparationService.setActiveRound(
                    detail.process.id,
                    roundId
                  );
                  await refresh(detail.process.id);
                } catch (reason) {
                  if (owns()) setError(errorMessage(reason));
                }
              }}
              onSetCurrentRound={(round) => {
                if (
                  currentContext.processId &&
                  (currentContext.processId !== detail.process.id ||
                    currentContext.roundId !== round.id)
                ) {
                  setCurrentRoundTarget(round);
                  return;
                }
                const owns = currentContextOperation.begin();
                void interviewPreparationSnapshotService
                  .setCurrentContext({
                    processId: detail.process.id,
                    roundId: round.id,
                  })
                  .then(() => data.refreshSelection())
                  .catch((reason) => { if (owns()) setError(errorMessage(reason)); });
              }}
              onArchive={handleArchive}
              onReopen={handleReopen}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
              Select an interview process
            </div>
          )}
        </section>

        <section
          className={
            expandedWorkspaceSurface === "conversation"
              ? "hidden"
              : expandedWorkspaceSurface === "review"
                ? "block min-h-0 min-w-0 overflow-y-auto"
                : `${mobilePanel === "review" ? "block" : "hidden"} min-h-0 min-w-0 overflow-y-auto border-l 2xl:block`
          }
        >
          <ReviewedStatePanel
            data={data}
            detail={detail}
            currentContext={currentContext}
            materials={materials}
            expanded={expandedWorkspaceSurface === "review"}
            onExpandedChange={handleReviewedStateExpandedChange}
            onMaterialsChanged={data.refreshMaterials}
            onMaterialError={data.onError}
            onMaterialNotice={data.onNotice}
            onCurrentContextChanged={data.refreshSelection}
          />
        </section>
      </div>

      <CreateProcessDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created, owns) => {
          void data.refreshProcess(created.process.id);
          if (!data.isCurrent() || !owns()) return;
          setCreateOpen(false);
          navigate(`/interview-preparation/${created.process.id}`);
          setMobilePanel("conversation");
        }}
      />
      <CreateRoundDialog
        key={processId}
        processId={detail?.process.id}
        open={roundOpen}
        onOpenChange={setRoundOpen}
        onCreated={async (owns) => {
          await refresh(detail?.process.id);
          if (data.isCurrent() && owns()) setRoundOpen(false);
        }}
      />
      <EditProcessDialog
        key={processId}
        process={detail?.process}
        open={processEditOpen}
        onOpenChange={setProcessEditOpen}
        onUpdated={async (owns) => {
          await refresh(detail?.process.id);
          if (data.isCurrent() && owns()) setProcessEditOpen(false);
        }}
      />
      <EditRoundDialog
        key={processId}
        processId={detail?.process.id}
        round={roundEditTarget}
        onOpenChange={(open) => {
          if (!open) setRoundEditTarget(undefined);
        }}
        onUpdated={async (owns) => {
          await refresh(detail?.process.id);
          if (data.isCurrent() && owns()) setRoundEditTarget(undefined);
        }}
      />
      <Dialog
        open={Boolean(roundDeleteTarget)}
        onOpenChange={(open) => {
          if (!open && !isDeletingRound) setRoundDeleteTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete interview round?</DialogTitle>
            <DialogDescription>
              This permanently removes {roundDeleteTarget?.title} and{" "}
              {roundDeleteTarget
                ? materials.filter(
                    (material) =>
                      material.scope.kind === "round" &&
                      material.scope.roundId === roundDeleteTarget.id
                  ).length
                : 0}{" "}
              round-specific materials. Related preparation data will also be
              deleted. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isDeletingRound}
              onClick={() => setRoundDeleteTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeletingRound}
              onClick={handleDeleteRound}
            >
              {isDeletingRound ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete round
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(currentRoundTarget)}
        onOpenChange={(open) => !open && setCurrentRoundTarget(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch the current interview context?</DialogTitle>
            <DialogDescription>
              {currentContext.selectedSnapshotId
                ? "This will deactivate the selected snapshot for the previous Round. Snapshot history remains available."
                : "This changes which Process and Round can select the single runtime snapshot."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCurrentRoundTarget(undefined)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!detail || !currentRoundTarget) return;
                const owns = currentContextOperation.begin();
                void interviewPreparationSnapshotService
                  .setCurrentContext({
                    processId: detail.process.id,
                    roundId: currentRoundTarget.id,
                    allowContextSwitch: true,
                  })
                  .then(async () => {
                    await data.refreshSelection();
                    if (owns()) setCurrentRoundTarget(undefined);
                  })
                  .catch((reason) => { if (owns()) setError(errorMessage(reason)); });
              }}
            >
              <Crosshair className="size-4" /> Set current
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    </div>
  );
};

const ProcessWorkspace = ({
  data,
  detail,
  currentContext,
  materials,
  onMaterialsChanged,
  onError,
  onNotice,
  onAddRound,
  onEditProcess,
  onEditRound,
  onDeleteRound,
  conversationExpanded,
  onConversationDetailChange,
  onSetActiveRound,
  onSetCurrentRound,
  onArchive,
  onReopen,
  onDelete,
}: {
  data: PreparationData;
  detail: InterviewProcessDetail;
  currentContext: PreparationCurrentContext;
  materials: PreparationMaterial[];
  onMaterialsChanged: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onAddRound: () => void;
  onEditProcess: () => void;
  onEditRound: (round: InterviewRound) => void;
  onDeleteRound: (round: InterviewRound) => void;
  conversationExpanded: boolean;
  onConversationDetailChange: (open: boolean) => void;
  onSetActiveRound: (roundId: string) => Promise<void>;
  onSetCurrentRound: (round: InterviewRound) => void;
  onArchive: () => Promise<void>;
  onReopen: () => Promise<void>;
  onDelete: () => void;
}) => (
  <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <div
      className={`${conversationExpanded ? "hidden" : "flex"} min-h-20 shrink-0 items-start justify-between gap-3 border-b px-4 py-3`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-base font-semibold">{detail.process.title}</h2>
          <Badge variant="outline">{detail.process.status}</Badge>
          {currentContext.processId === detail.process.id && (
            <Badge className="rounded-sm text-[10px]">Current</Badge>
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {[detail.process.company, detail.process.role].filter(Boolean).join(" · ") ||
            "Company and role unresolved"}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {detail.process.status === "active" && (
          <Button
            size="icon"
            variant="outline"
            title="Edit process"
            onClick={onEditProcess}
          >
            <Pencil className="size-4" />
          </Button>
        )}
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

    <div className={conversationExpanded ? "hidden" : "flex min-h-0 max-h-[25%] shrink-0 flex-col border-b"}>
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
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
      <div className="min-h-0 overflow-y-auto border-t">
        {detail.rounds.map((round) => {
          const active = round.id === detail.process.activeRoundId;
          const current =
            currentContext.processId === detail.process.id &&
            currentContext.roundId === round.id;
          return (
            <div
              key={round.id}
              className={`flex items-stretch border-b last:border-b-0 ${active ? "bg-muted/50" : ""}`}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-muted/60 disabled:cursor-default"
                onClick={() => onSetActiveRound(round.id)}
                disabled={active || detail.process.status === "archived"}
                aria-current={active ? "step" : undefined}
              >
                {active ? (
                  <CheckCircle2 className="size-4 shrink-0 text-foreground" />
                ) : (
                  <Circle className="size-4 shrink-0 text-muted-foreground/35" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{round.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatRoundStageLabel(round)}</span>
                    {round.scheduledAt && (
                      <span className="flex items-center gap-1">
                        <CalendarDays className="size-3" />
                        {new Date(round.scheduledAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              </button>
              <div className="flex shrink-0 items-center pr-1">
                <div className="relative flex size-9 shrink-0 items-center justify-center">
                  {current ? (
                    <Badge
                      className="absolute right-2.5 shrink-0 whitespace-nowrap rounded-sm text-[10px]"
                      aria-label={`${round.title} is the current interview round`}
                    >
                      Current
                    </Badge>
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0"
                      title={`Set ${round.title} as current`}
                      aria-label={`Set ${round.title} as current`}
                      disabled={detail.process.status === "archived"}
                      onClick={() => onSetCurrentRound(round)}
                    >
                      <Crosshair className="size-4" />
                    </Button>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  title={`Edit ${round.title}`}
                  disabled={detail.process.status === "archived"}
                  onClick={() => onEditRound(round)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0"
                  title={
                    detail.rounds.length <= 1
                      ? "An interview process must keep one round"
                      : `Delete ${round.title}`
                  }
                  disabled={
                    detail.process.status === "archived" ||
                    detail.rounds.length <= 1
                  }
                  onClick={() => onDeleteRound(round)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>

    <PreparationConversationPanel
      data={data}
      key={detail.process.id}
      detail={detail}
      materials={materials}
      onMaterialsChanged={onMaterialsChanged}
      onError={onError}
      onNotice={onNotice}
      onDetailViewChange={onConversationDetailChange}
    />
  </div>
);

const ReviewedStatePanel = ({
  data,
  detail,
  currentContext,
  materials,
  onMaterialsChanged,
  onMaterialError,
  onMaterialNotice,
  expanded,
  onExpandedChange,
  onCurrentContextChanged,
}: {
  data: PreparationData;
  detail?: InterviewProcessDetail;
  currentContext: PreparationCurrentContext;
  materials: PreparationMaterial[];
  onMaterialsChanged: (materialId?: string) => Promise<void>;
  onMaterialError: (message: string) => void;
  onMaterialNotice: (message: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onCurrentContextChanged: () => Promise<void>;
}) => (
  <div className="min-h-[640px]">
    {detail && (
      <div className={expanded ? "hidden" : "block"}>
        <MaterialPanel
          key={detail.process.id}
          data={data}
          processId={detail.process.id}
          processStatus={detail.process.status}
          activeRoundId={detail.process.activeRoundId}
          rounds={detail.rounds}
          materials={materials}
          onChanged={onMaterialsChanged}
          onError={onMaterialError}
          onNotice={onMaterialNotice}
        />
      </div>
    )}
    {detail ? (
      <ReviewedPreparationPanel
        key={detail.process.id}
        data={data}
        detail={detail}
        currentContext={currentContext}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        onError={onMaterialError}
        onNotice={onMaterialNotice}
        onCurrentContextChanged={onCurrentContextChanged}
      />
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
  onCreated: (detail: InterviewProcessDetail, owns: () => boolean) => void;
}) => {
  const operation = usePageOperation(String(open));
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [stage, setStage] = useState<InterviewRoundStage>("recruiter-screen");
  const [customStageLabel, setCustomStageLabel] = useState("");
  const [expectedTypes, setExpectedTypes] = useState<
    PreparationExpectedInterviewType[]
  >([...PREPARATION_EXPECTED_INTERVIEW_TYPES]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { setIsSaving(false); }, [open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const owns = operation.begin();
    setIsSaving(true);
    setError(undefined);
    try {
      const created = await interviewPreparationService.create({
        title,
        company,
        role,
        initialRound: {
          stage,
          customStageLabel,
          expectedInterviewTypes: stage === "mixed" ? expectedTypes : undefined,
        },
      });
      if (owns()) {
        setTitle("");
        setCompany("");
        setRole("");
        setStage("recruiter-screen");
        setCustomStageLabel("");
        setExpectedTypes([...PREPARATION_EXPECTED_INTERVIEW_TYPES]);
      }
      onCreated(created, owns);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    } finally {
      if (owns()) setIsSaving(false);
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
          {stage === "other" && (
            <Field label="Custom stage">
              <Input
                value={customStageLabel}
                maxLength={80}
                onChange={(event) => setCustomStageLabel(event.target.value)}
                placeholder="e.g. Product sense"
              />
            </Field>
          )}
          {stage === "mixed" && (
            <ExpectedInterviewTypeSelector
              value={expectedTypes}
              onChange={setExpectedTypes}
            />
          )}
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !title.trim() ||
                (stage === "other" && !customStageLabel.trim()) ||
                (stage === "mixed" && expectedTypes.length < 2) ||
                isSaving
              }
            >
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
  onCreated: (owns: () => boolean) => Promise<void>;
}) => {
  const operation = usePageOperation(JSON.stringify([processId, open]));
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<InterviewRoundStage>("coding");
  const [customStageLabel, setCustomStageLabel] = useState("");
  const [expectedTypes, setExpectedTypes] = useState<
    PreparationExpectedInterviewType[]
  >([...PREPARATION_EXPECTED_INTERVIEW_TYPES]);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { setIsSaving(false); }, [processId, open]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!processId) return;
    const owns = operation.begin();
    setIsSaving(true);
    setError(undefined);
    try {
      await interviewPreparationService.addRound(processId, {
        title,
        stage,
        customStageLabel,
        expectedInterviewTypes: stage === "mixed" ? expectedTypes : undefined,
        scheduledAt: localRoundScheduleToTimestamp({
          date: scheduledDate,
          time: scheduledTime,
        }),
      });
      if (owns()) {
        setTitle("");
        setCustomStageLabel("");
        setExpectedTypes([...PREPARATION_EXPECTED_INTERVIEW_TYPES]);
        setScheduledDate("");
        setScheduledTime("");
      }
      await onCreated(owns);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    } finally {
      if (owns()) setIsSaving(false);
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
          {stage === "other" && (
            <Field label="Custom stage">
              <Input
                value={customStageLabel}
                maxLength={80}
                onChange={(event) => setCustomStageLabel(event.target.value)}
                placeholder="e.g. Product sense"
              />
            </Field>
          )}
          {stage === "mixed" && (
            <ExpectedInterviewTypeSelector
              value={expectedTypes}
              onChange={setExpectedTypes}
            />
          )}
          <RoundScheduleFields
            date={scheduledDate}
            time={scheduledTime}
            onDateChange={setScheduledDate}
            onTimeChange={setScheduledTime}
          />
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !processId ||
                (stage === "other" && !customStageLabel.trim()) ||
                (stage === "mixed" && expectedTypes.length < 2) ||
                isSaving
              }
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Add round
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const EditProcessDialog = ({
  process,
  open,
  onOpenChange,
  onUpdated,
}: {
  process?: InterviewProcess;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (owns: () => boolean) => Promise<void>;
}) => {
  const operation = usePageOperation(JSON.stringify([process?.id, open]));
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setIsSaving(false);
    if (!open || !process) return;
    setTitle(process.title);
    setCompany(process.company ?? "");
    setRole(process.role ?? "");
    setError(undefined);
  }, [open, process?.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!process) return;
    const owns = operation.begin();
    setIsSaving(true);
    setError(undefined);
    try {
      await interviewPreparationService.updateProcess(process.id, {
        title,
        company,
        role,
      });
      await onUpdated(owns);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    } finally {
      if (owns()) setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit interview process</DialogTitle>
            <DialogDescription>
              Existing rounds and material scopes keep their identities.
            </DialogDescription>
          </DialogHeader>
          <Field label="Process title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company">
              <Input value={company} onChange={(event) => setCompany(event.target.value)} />
            </Field>
            <Field label="Role">
              <Input value={role} onChange={(event) => setRole(event.target.value)} />
            </Field>
          </div>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!process || !title.trim() || isSaving}>
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const EditRoundDialog = ({
  processId,
  round,
  onOpenChange,
  onUpdated,
}: {
  processId?: string;
  round?: InterviewRound;
  onOpenChange: (open: boolean) => void;
  onUpdated: (owns: () => boolean) => Promise<void>;
}) => {
  const operation = usePageOperation(JSON.stringify([processId, round?.id]));
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<InterviewRoundStage>("coding");
  const [customStageLabel, setCustomStageLabel] = useState("");
  const [expectedTypes, setExpectedTypes] = useState<
    PreparationExpectedInterviewType[]
  >([...PREPARATION_EXPECTED_INTERVIEW_TYPES]);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setIsSaving(false);
    if (!round) return;
    setTitle(round.title);
    setStage(round.stage);
    setCustomStageLabel(round.customStageLabel ?? "");
    setExpectedTypes(
      round.stage === "mixed"
        ? round.expectedInterviewTypes
        : [...PREPARATION_EXPECTED_INTERVIEW_TYPES]
    );
    const schedule = timestampToLocalRoundSchedule(round.scheduledAt);
    setScheduledDate(schedule.date);
    setScheduledTime(schedule.time);
    setError(undefined);
  }, [round?.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!processId || !round) return;
    const owns = operation.begin();
    setIsSaving(true);
    setError(undefined);
    try {
      await interviewPreparationService.updateRound(processId, round.id, {
        title,
        stage,
        customStageLabel,
        expectedInterviewTypes: stage === "mixed" ? expectedTypes : undefined,
        scheduledAt: localRoundScheduleToTimestamp({
          date: scheduledDate,
          time: scheduledTime,
        }),
      });
      await onUpdated(owns);
    } catch (reason) {
      if (owns()) setError(errorMessage(reason));
    } finally {
      if (owns()) setIsSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(round)} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit interview round</DialogTitle>
            <DialogDescription>
              The round ID and existing material assignments remain unchanged.
            </DialogDescription>
          </DialogHeader>
          <Field label="Round title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Stage">
            <RoundStageSelect value={stage} onChange={setStage} />
          </Field>
          {stage === "other" && (
            <Field label="Custom stage">
              <Input
                value={customStageLabel}
                maxLength={80}
                onChange={(event) => setCustomStageLabel(event.target.value)}
                placeholder="e.g. Product sense"
              />
            </Field>
          )}
          {stage === "mixed" && (
            <ExpectedInterviewTypeSelector
              value={expectedTypes}
              onChange={setExpectedTypes}
            />
          )}
          <RoundScheduleFields
            date={scheduledDate}
            time={scheduledTime}
            onDateChange={setScheduledDate}
            onTimeChange={setScheduledTime}
          />
          {error && <div className="text-sm text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                !processId ||
                !round ||
                (stage === "other" && !customStageLabel.trim()) ||
                (stage === "mixed" && expectedTypes.length < 2) ||
                isSaving
              }
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const ExpectedInterviewTypeSelector = ({
  value,
  onChange,
}: {
  value: PreparationExpectedInterviewType[];
  onChange: (value: PreparationExpectedInterviewType[]) => void;
}) => {
  const selected = new Set(value);
  return (
    <div className="grid gap-1.5 text-sm">
      <div>
        <div className="font-medium">Expected interview types</div>
        <div className="text-xs text-muted-foreground">
          Mixed requires at least two types. The compiled snapshot preserves this
          exact set.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {PREPARATION_EXPECTED_INTERVIEW_TYPES.map((type) => {
          const active = selected.has(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={active}
              className={`flex min-h-9 items-center gap-1.5 border px-2 py-1.5 text-left text-xs ${active ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground"}`}
              onClick={() =>
                onChange(
                  active
                    ? value.filter((candidate) => candidate !== type)
                    : [...value, type].sort()
                )
              }
            >
              <span className="flex size-4 shrink-0 items-center justify-center border">
                {active && <Check className="size-3" />}
              </span>
              <span>{formatExpectedInterviewType(type)}</span>
            </button>
          );
        })}
      </div>
      {value.length < 2 && (
        <div className="text-xs text-destructive">
          Select at least two interview types.
        </div>
      )}
    </div>
  );
};

const RoundScheduleFields = ({
  date,
  time,
  onDateChange,
  onTimeChange,
}: {
  date: string;
  time: string;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
}) => (
  <div className="grid gap-1.5 text-sm">
    <span className="font-medium">Scheduled time</span>
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
      <Input
        type="date"
        value={date}
        aria-label="Scheduled date"
        onChange={(event) => onDateChange(event.target.value)}
      />
      <Select value={time} onValueChange={onTimeChange}>
        <SelectTrigger className="w-full" aria-label="Scheduled time">
          <SelectValue placeholder="Select time" />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {buildRoundTimeOptions(time).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        disabled={!date && !time}
        onClick={() => {
          onDateChange("");
          onTimeChange("");
        }}
      >
        Clear
      </Button>
    </div>
  </div>
);

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
  <>
    <div className="grid shrink-0 grid-cols-3 border lg:hidden">
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
    <div className="hidden shrink-0 grid-cols-2 border lg:grid 2xl:hidden">
      <button
        className={`h-9 border-r text-xs ${value !== "review" ? "bg-primary text-primary-foreground" : "bg-background"}`}
        onClick={() => onChange("conversation")}
      >
        Workspace
      </button>
      <button
        className={`h-9 text-xs ${value === "review" ? "bg-primary text-primary-foreground" : "bg-background"}`}
        onClick={() => onChange("review")}
      >
        Reviewed
      </button>
    </div>
  </>
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

function formatExpectedInterviewType(type: PreparationExpectedInterviewType) {
  return type
    .split("-")
    .map((word) =>
      word === "ai" || word === "ml"
        ? word.toUpperCase()
        : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`
    )
    .join(" ")
    .replace("AI ML", "AI/ML");
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export default InterviewPreparation;
