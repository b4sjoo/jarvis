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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@/components";
import { useApp } from "@/contexts";
import {
  formatPreparationModelRouteError,
  createPreparationProfileSourceFingerprint,
  diffPreparationSnapshots,
  interviewPreparationCompositionService,
  interviewPreparationConversationService,
  interviewPreparationSnapshotService,
  interviewPreparationStatementProposalService,
  interviewPreparationStatementService,
  PREPARATION_NARRATIVE_SUBJECT_KINDS,
  PREPARATION_STATEMENT_DOMAINS,
  type InterviewPreparationProfileRevision,
  type InterviewPreparationSnapshot,
  type InterviewProcessDetail,
  type PreparationCurrentContext,
  type PreparationSnapshotDiffSection,
  type PreparationConversation,
  type PreparationConversationScope,
  type PreparationNarrativeGraph,
  type PreparationNarrativeNode,
  type PreparationNarrativeReviewStatus,
  type PreparationNarrativeSubjectKind,
  type PreparationStatementDomain,
  type PreparationStatementOwnership,
  type PreparationStatementReviewEvent,
  type PreparationStatementStatus,
  type PreparationStatementWithSources,
} from "@/lib/preparation";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleHelp,
  FileSearch,
  Layers3,
  Loader2,
  Maximize2,
  PackageCheck,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const PROCESS_SCOPE = "process";

export const ReviewedPreparationPanel = ({
  detail,
  currentContext,
  expanded,
  onExpandedChange,
  onError,
  onNotice,
  onCurrentContextChanged,
}: {
  detail: InterviewProcessDetail;
  currentContext: PreparationCurrentContext;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onCurrentContextChanged: () => Promise<void>;
}) => {
  const { allAiProviders, selectedPreparationAIProvider } = useApp();
  const [scopeValue, setScopeValue] = useState(
    detail.process.activeRoundId
      ? `round:${detail.process.activeRoundId}`
      : PROCESS_SCOPE
  );
  const [statements, setStatements] = useState<PreparationStatementWithSources[]>([]);
  const [conversations, setConversations] = useState<PreparationConversation[]>([]);
  const [profile, setProfile] = useState<InterviewPreparationProfileRevision>();
  const [narratives, setNarratives] = useState<PreparationNarrativeGraph[]>([]);
  const [snapshots, setSnapshots] = useState<InterviewPreparationSnapshot[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] =
    useState<InterviewPreparationSnapshot>();
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [statusFilter, setStatusFilter] = useState<PreparationStatementStatus | "all">(
    "all"
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isGeneratingProposals, setIsGeneratingProposals] = useState(false);
  const [isComposingProfile, setIsComposingProfile] = useState(false);
  const [isCompilingSnapshot, setIsCompilingSnapshot] = useState(false);
  const [snapshotReview, setSnapshotReview] =
    useState<InterviewPreparationSnapshot>();
  const [reviewTarget, setReviewTarget] = useState<PreparationStatementWithSources>();
  const [sourceTarget, setSourceTarget] = useState<PreparationStatementWithSources>();
  const [reviewEvents, setReviewEvents] = useState<PreparationStatementReviewEvent[]>([]);
  const [narrativeDialogOpen, setNarrativeDialogOpen] = useState(false);
  const [narrativeReview, setNarrativeReview] = useState<{
    graph: PreparationNarrativeGraph;
    node: PreparationNarrativeNode;
  }>();
  const proposalAbortRef = useRef<AbortController | undefined>(undefined);
  const narrativeAbortRef = useRef<AbortController | undefined>(undefined);
  const readOnly = detail.process.status !== "active";
  const scope = useMemo(() => parseScope(scopeValue), [scopeValue]);
  const visibleConversations = useMemo(
    () =>
      conversations.filter(
        (conversation) =>
          conversation.scope.kind === "process" ||
          (conversation.scope.kind === "round" &&
            scope.kind === "round" &&
            conversation.scope.roundId === scope.roundId)
      ),
    [conversations, scope]
  );
  const filteredStatements = useMemo(
    () =>
      statusFilter === "all"
        ? statements
        : statements.filter((statement) => statement.status === statusFilter),
    [statements, statusFilter]
  );
  const confirmedStatements = statements.filter(
    (statement) => statement.status === "confirmed"
  );
  const profileIsCurrent =
    !!profile &&
    profile.sourceFingerprint ===
      createPreparationProfileSourceFingerprint(confirmedStatements);
  const route = interviewPreparationStatementProposalService.resolveRoute({
    providers: allAiProviders,
    selectedProvider: selectedPreparationAIProvider,
  });

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const [
        nextStatements,
        nextConversations,
        nextProfile,
        nextNarratives,
        nextSnapshots,
        nextSelectedSnapshot,
      ] =
        await Promise.all([
          interviewPreparationStatementService.list({
            processId: detail.process.id,
            roundId: scope.kind === "round" ? scope.roundId : undefined,
          }),
          interviewPreparationConversationService.list(detail.process.id),
          interviewPreparationCompositionService.getLatestProfile({
            processId: detail.process.id,
            scope,
          }),
          interviewPreparationCompositionService.listNarratives({
            processId: detail.process.id,
            roundId: scope.kind === "round" ? scope.roundId : undefined,
          }),
          scope.kind === "round"
            ? interviewPreparationSnapshotService.list({
                processId: detail.process.id,
                roundId: scope.roundId,
              })
            : Promise.resolve([]),
          interviewPreparationSnapshotService.getCurrentSnapshot(),
        ]);
      setStatements(nextStatements);
      setConversations(nextConversations);
      setProfile(nextProfile);
      setNarratives(
        nextNarratives.filter((graph) => sameScope(graph.scope, scope))
      );
      setSnapshots(nextSnapshots);
      setSelectedSnapshot(nextSelectedSnapshot);
      setSelectedConversationId((current) => {
        const currentConversation = nextConversations.find(
          (conversation) => conversation.id === current
        );
        if (
          currentConversation &&
          isConversationVisibleToScope(currentConversation.scope, scope)
        ) {
          return current;
        }
        const exact = nextConversations.find((conversation) =>
          sameScope(conversation.scope, scope)
        );
        const processConversation = nextConversations.find(
          (conversation) => conversation.scope.kind === "process"
        );
        return exact?.id ?? processConversation?.id ?? "";
      });
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsLoading(false);
    }
  }, [detail.process.id, onError, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      proposalAbortRef.current?.abort();
      narrativeAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    const next = detail.process.activeRoundId
      ? `round:${detail.process.activeRoundId}`
      : PROCESS_SCOPE;
    setScopeValue(next);
  }, [detail.process.activeRoundId, detail.process.id]);

  const generateProposals = async () => {
    if (!selectedConversationId || readOnly || isGeneratingProposals) return;
    if (route.status !== "ready") {
      onError(formatPreparationModelRouteError(route));
      return;
    }
    const controller = new AbortController();
    proposalAbortRef.current = controller;
    setIsGeneratingProposals(true);
    try {
      const result = await interviewPreparationStatementProposalService.generate({
        processId: detail.process.id,
        conversationId: selectedConversationId,
        route,
        signal: controller.signal,
      });
      if (result.status === "committed") {
        onNotice(
          result.acceptedCount
            ? `${result.acceptedCount} statement proposal${result.acceptedCount === 1 ? "" : "s"} ready for review`
            : "No new statement proposals were found"
        );
      } else if (result.status === "stale") {
        onNotice("Proposal result was discarded because its evidence changed");
      }
      await refresh();
    } catch (reason) {
      if (!controller.signal.aborted) onError(errorMessage(reason));
    } finally {
      if (proposalAbortRef.current === controller) {
        proposalAbortRef.current = undefined;
      }
      setIsGeneratingProposals(false);
    }
  };

  const composeProfile = async () => {
    if (readOnly || isComposingProfile) return;
    setIsComposingProfile(true);
    try {
      const result = await interviewPreparationCompositionService.composeProfile({
        processId: detail.process.id,
        scope,
      });
      onNotice(
        result.created
          ? `Profile revision ${result.profile.revision} composed`
          : `Profile revision ${result.profile.revision} is already current`
      );
      await refresh();
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsComposingProfile(false);
    }
  };

  const compileSnapshot = async () => {
    if (
      readOnly ||
      isCompilingSnapshot ||
      scope.kind !== "round" ||
      !profile ||
      !profileIsCurrent
    ) {
      return;
    }
    setIsCompilingSnapshot(true);
    try {
      const result = await interviewPreparationSnapshotService.compile({
        processId: detail.process.id,
        roundId: scope.roundId,
        profileRevisionId: profile.id,
      });
      onNotice(
        result.created
          ? `Snapshot version ${result.snapshot.version} compiled for review`
          : `Snapshot version ${result.snapshot.version} already matches the current preparation state`
      );
      await refresh();
      setSnapshotReview(result.snapshot);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsCompilingSnapshot(false);
    }
  };

  const openSources = async (statement: PreparationStatementWithSources) => {
    setSourceTarget(statement);
    setReviewEvents([]);
    try {
      setReviewEvents(
        await interviewPreparationStatementService.listEvents(
          detail.process.id,
          statement.id
        )
      );
    } catch (reason) {
      onError(errorMessage(reason));
    }
  };

  return (
    <div className="border-t">
      <div className="flex min-h-12 items-center justify-between gap-2 border-b px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={expanded ? "Back to preparation workspace" : "Expand reviewed state"}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? (
            <ArrowLeft className="size-4 shrink-0" />
          ) : (
            <Maximize2 className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Reviewed State</span>
            <span className="block text-xs text-muted-foreground">
              {expanded ? "Back to preparation workspace" : "Draft only · not active"}
            </span>
          </span>
        </button>
        <Select value={scopeValue} onValueChange={setScopeValue}>
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROCESS_SCOPE}>Entire process</SelectItem>
            {detail.rounds.map((round) => (
              <SelectItem key={round.id} value={`round:${round.id}`}>
                {round.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="claims" className="gap-0">
        <TabsList className="m-3 grid w-[calc(100%-1.5rem)] grid-cols-4 rounded-md">
          <TabsTrigger className="rounded-sm px-1 text-xs" value="claims">
            Claims
          </TabsTrigger>
          <TabsTrigger className="rounded-sm px-1 text-xs" value="profile">
            Profile
          </TabsTrigger>
          <TabsTrigger className="rounded-sm px-1 text-xs" value="narratives">
            Narratives
          </TabsTrigger>
          <TabsTrigger className="rounded-sm px-1 text-xs" value="snapshots">
            Snapshots
          </TabsTrigger>
        </TabsList>

        <TabsContent value="claims" className="mt-0">
          <div className="grid gap-2 border-y bg-muted/30 p-3">
            <Select
              value={selectedConversationId}
              onValueChange={setSelectedConversationId}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Choose evidence conversation" />
              </SelectTrigger>
              <SelectContent>
                {visibleConversations.map((conversation) => (
                  <SelectItem key={conversation.id} value={conversation.id}>
                    {conversation.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="w-full"
              disabled={
                readOnly ||
                !selectedConversationId ||
                isGeneratingProposals ||
                route.status !== "ready"
              }
              title={
                route.status === "ready"
                  ? "Generate reviewable statements"
                  : formatPreparationModelRouteError(route)
              }
              onClick={generateProposals}
            >
              {isGeneratingProposals ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Generate proposals
            </Button>
          </div>
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {statements.length} statements
            </span>
            <Select
              value={statusFilter}
              onValueChange={(value) =>
                setStatusFilter(value as PreparationStatementStatus | "all")
              }
            >
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["all", "proposed", "confirmed", "unresolved", "rejected"].map(
                  (status) => (
                    <SelectItem key={status} value={status}>
                      {labelize(status)}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
          </div>
          <div
            className={`${expanded ? "max-h-[calc(100vh-17rem)]" : "max-h-[520px]"} overflow-y-auto`}
          >
            {isLoading ? (
              <LoadingState />
            ) : filteredStatements.length ? (
              filteredStatements.map((statement) => (
                <StatementRow
                  key={statement.id}
                  statement={statement}
                  readOnly={readOnly}
                  onReview={() => setReviewTarget(statement)}
                  onSources={() => void openSources(statement)}
                />
              ))
            ) : (
              <EmptyState text="No statements in this scope" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="profile" className="mt-0">
          <div className="border-y bg-muted/30 p-3">
            <Button
              size="sm"
              className="w-full"
              disabled={readOnly || isComposingProfile || !confirmedStatements.length}
              onClick={composeProfile}
            >
              {isComposingProfile ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Compose confirmed profile
            </Button>
          </div>
          {profile ? (
            <ProfileView
              profile={profile}
              isCurrent={profileIsCurrent}
              expanded={expanded}
            />
          ) : (
            <EmptyState text="Confirm statements, then compose a profile" />
          )}
        </TabsContent>

        <TabsContent value="narratives" className="mt-0">
          <div className="border-y bg-muted/30 p-3">
            <Button
              size="sm"
              className="w-full"
              disabled={
                readOnly ||
                !profile ||
                !profileIsCurrent ||
                !confirmedStatements.length
              }
              title={
                profile && !profileIsCurrent
                  ? "Recompose the profile after statement changes"
                  : "Generate a narrative draft from confirmed statements"
              }
              onClick={() => setNarrativeDialogOpen(true)}
            >
              <Layers3 className="size-4" /> Generate narrative draft
            </Button>
          </div>
          <div
            className={`${expanded ? "max-h-[calc(100vh-15rem)]" : "max-h-[560px]"} overflow-y-auto`}
          >
            {narratives.length ? (
              narratives.map((graph) => (
                <NarrativeGraphRow
                  key={graph.id}
                  graph={graph}
                  readOnly={readOnly}
                  onReview={(node) => setNarrativeReview({ graph, node })}
                />
              ))
            ) : (
              <EmptyState text="No narrative drafts in this scope" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="snapshots" className="mt-0">
          <div className="border-y bg-muted/30 p-3">
            <Button
              size="sm"
              className="w-full"
              disabled={
                readOnly ||
                isCompilingSnapshot ||
                scope.kind !== "round" ||
                !profile ||
                !profileIsCurrent
              }
              title={
                scope.kind !== "round"
                  ? "Choose a round scope before compiling a runtime snapshot"
                  : !profile
                    ? "Compose a current Round profile before compiling a snapshot; Narrative drafts are optional"
                    : !profileIsCurrent
                    ? "Recompose the profile before compiling a snapshot"
                    : "Compile an immutable runtime snapshot for review"
              }
              onClick={() => void compileSnapshot()}
            >
              {isCompilingSnapshot ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <PackageCheck className="size-4" />
              )}
              Compile snapshot
            </Button>
            {scope.kind === "round" && (!profile || !profileIsCurrent) && (
              <div className="mt-2 text-xs text-muted-foreground">
                {!profile
                  ? "A current Round profile is required. Narrative drafts are optional."
                  : "The reviewed statements changed. Recompose the Round profile first."}
              </div>
            )}
          </div>
          <div
            className={`${expanded ? "max-h-[calc(100vh-15rem)]" : "max-h-[560px]"} overflow-y-auto`}
          >
            {scope.kind !== "round" ? (
              <EmptyState text="Choose a round scope to compile and activate snapshots" />
            ) : snapshots.length ? (
              snapshots.map((snapshot) => (
                <SnapshotRow
                  key={snapshot.id}
                  snapshot={snapshot}
                  stale={
                    !profileIsCurrent || snapshot.profileRevisionId !== profile?.id
                  }
                  onReview={() => setSnapshotReview(snapshot)}
                />
              ))
            ) : (
              <EmptyState text="No compiled snapshots for this round" />
            )}
          </div>
        </TabsContent>
      </Tabs>

      <StatementReviewDialog
        statement={reviewTarget}
        readOnly={readOnly}
        onOpenChange={(open) => !open && setReviewTarget(undefined)}
        onSave={async (input) => {
          if (!reviewTarget) return;
          await interviewPreparationStatementService.review({
            processId: detail.process.id,
            statementId: reviewTarget.id,
            expectedRevision: reviewTarget.revision,
            ...input,
          });
          setReviewTarget(undefined);
          await refresh();
          onNotice(`Statement marked ${input.status}`);
        }}
      />
      <SourceDialog
        statement={sourceTarget}
        events={reviewEvents}
        onOpenChange={(open) => !open && setSourceTarget(undefined)}
      />
      <NarrativeCreateDialog
        open={narrativeDialogOpen}
        scope={scope}
        profile={profile}
        statements={confirmedStatements}
        route={route}
        processId={detail.process.id}
        onOpenChange={setNarrativeDialogOpen}
        onCreated={async () => {
          setNarrativeDialogOpen(false);
          await refresh();
          onNotice("Narrative draft generated for review");
        }}
        onError={onError}
        abortRef={narrativeAbortRef}
      />
      <NarrativeReviewDialog
        target={narrativeReview}
        readOnly={readOnly}
        onOpenChange={(open) => !open && setNarrativeReview(undefined)}
        onSave={async (contentDraft, reviewStatus) => {
          if (!narrativeReview) return;
          await interviewPreparationCompositionService.reviewNarrativeNode({
            processId: detail.process.id,
            graphId: narrativeReview.graph.id,
            nodeId: narrativeReview.node.id,
            expectedRevision: narrativeReview.node.revision,
            contentDraft,
            reviewStatus,
          });
          setNarrativeReview(undefined);
          await refresh();
          onNotice(`Narrative node marked ${reviewStatus}`);
        }}
        onError={onError}
      />
      <SnapshotReviewDialog
        snapshot={snapshotReview}
        selectedSnapshot={selectedSnapshot}
        comparisonSnapshot={resolveSnapshotComparison({
          snapshot: snapshotReview,
          selectedSnapshot,
          snapshots,
        })}
        currentContext={currentContext}
        stale={
          Boolean(snapshotReview) &&
          (!profileIsCurrent || snapshotReview?.profileRevisionId !== profile?.id)
        }
        readOnly={readOnly}
        onOpenChange={(open) => !open && setSnapshotReview(undefined)}
        onActivate={async (allowContextSwitch) => {
          if (!snapshotReview) return;
          const active = await interviewPreparationSnapshotService.activate({
            processId: detail.process.id,
            roundId: snapshotReview.roundId,
            snapshotId: snapshotReview.id,
            allowContextSwitch,
          });
          setSnapshotReview(active);
          await Promise.all([refresh(), onCurrentContextChanged()]);
          onNotice(`Snapshot version ${active.version} activated`);
        }}
        onDeactivate={async () => {
          if (!snapshotReview) return;
          const deactivated =
            await interviewPreparationSnapshotService.deactivate({
              processId: detail.process.id,
              roundId: snapshotReview.roundId,
              snapshotId: snapshotReview.id,
            });
          setSnapshotReview(deactivated);
          await Promise.all([refresh(), onCurrentContextChanged()]);
          onNotice(`Snapshot version ${deactivated.version} deactivated`);
        }}
      />
    </div>
  );
};

const SnapshotRow = ({
  snapshot,
  stale,
  onReview,
}: {
  snapshot: InterviewPreparationSnapshot;
  stale: boolean;
  onReview: () => void;
}) => (
  <button
    type="button"
    className="flex w-full items-start justify-between gap-3 border-b px-3 py-3 text-left hover:bg-muted/40"
    onClick={onReview}
  >
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-semibold">Version {snapshot.version}</span>
        <Badge
          variant={snapshot.status === "active" ? "default" : "secondary"}
          className="rounded-sm text-[10px]"
        >
          {labelize(snapshot.status)}
        </Badge>
        {stale && (
          <Badge variant="destructive" className="rounded-sm text-[10px]">
            Stale
          </Badge>
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        Profile r{snapshot.profileRevision} · {snapshot.runtimeCharCount.toLocaleString()} runtime chars · {snapshot.warnings.length} warnings
      </div>
      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
        {snapshot.contentHash}
      </div>
    </div>
    <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
  </button>
);

const SnapshotReviewDialog = ({
  snapshot,
  selectedSnapshot,
  comparisonSnapshot,
  currentContext,
  stale,
  readOnly,
  onOpenChange,
  onActivate,
  onDeactivate,
}: {
  snapshot?: InterviewPreparationSnapshot;
  selectedSnapshot?: InterviewPreparationSnapshot;
  comparisonSnapshot?: InterviewPreparationSnapshot;
  currentContext: PreparationCurrentContext;
  stale: boolean;
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onActivate: (allowContextSwitch: boolean) => Promise<void>;
  onDeactivate: () => Promise<void>;
}) => {
  const [isChangingSelection, setIsChangingSelection] = useState(false);
  const [localError, setLocalError] = useState("");
  const [confirmContextSwitch, setConfirmContextSwitch] = useState(false);
  const diff = useMemo(
    () =>
      snapshot
        ? diffPreparationSnapshots(
            snapshot,
            comparisonSnapshot
          )
        : [],
    [comparisonSnapshot, snapshot]
  );

  useEffect(() => {
    setLocalError("");
    setConfirmContextSwitch(false);
  }, [snapshot?.id]);

  const activate = async (allowContextSwitch = false) => {
    if (
      !allowContextSwitch &&
      snapshot &&
      currentContext.processId &&
      (currentContext.processId !== snapshot.processId ||
        currentContext.roundId !== snapshot.roundId)
    ) {
      setConfirmContextSwitch(true);
      return;
    }
    setIsChangingSelection(true);
    setLocalError("");
    try {
      await onActivate(allowContextSwitch);
      setConfirmContextSwitch(false);
    } catch (reason) {
      setLocalError(errorMessage(reason));
    } finally {
      setIsChangingSelection(false);
    }
  };

  const deactivate = async () => {
    setIsChangingSelection(true);
    setLocalError("");
    try {
      await onDeactivate();
    } catch (reason) {
      setLocalError(errorMessage(reason));
    } finally {
      setIsChangingSelection(false);
    }
  };

  const isActive = snapshot?.id === currentContext.selectedSnapshotId;
  const isRollback =
    snapshot !== undefined &&
    selectedSnapshot !== undefined &&
    snapshot.processId === selectedSnapshot.processId &&
    snapshot.roundId === selectedSnapshot.roundId &&
    snapshot.id !== selectedSnapshot.id &&
    snapshot.version < selectedSnapshot.version;

  return (
    <Dialog open={Boolean(snapshot)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] w-[calc(100vw-2rem)] max-w-6xl overflow-x-hidden overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>
            Review snapshot{snapshot ? ` v${snapshot.version}` : ""}
          </DialogTitle>
          <DialogDescription>
            Activation selects this immutable package for future Meeting Assistant sessions. A session already in progress keeps its pinned version.
          </DialogDescription>
        </DialogHeader>
        {snapshot && (
          <div className="grid min-w-0 gap-4">
            <div className="grid grid-cols-2 gap-px border bg-border text-xs sm:grid-cols-4">
              <SnapshotMetric label="Status" value={labelize(snapshot.status)} />
              <SnapshotMetric
                label="Runtime size"
                value={snapshot.runtimeCharCount.toLocaleString()}
              />
              <SnapshotMetric
                label="Evidence"
                value={String(snapshot.evidencePack.items.length)}
              />
              <SnapshotMetric
                label="Narratives"
                value={String(snapshot.narrativePack.graphs.length)}
              />
            </div>

            <section>
              <div className="text-xs font-semibold">
                {comparisonSnapshot
                  ? `Changes from ${comparisonSnapshot.id === selectedSnapshot?.id ? "selected" : "previous"} snapshot v${comparisonSnapshot.version}`
                  : "Initial activation contents"}
              </div>
              {comparisonSnapshot &&
                (comparisonSnapshot.processId !== snapshot.processId ||
                  comparisonSnapshot.roundId !== snapshot.roundId) && (
                  <div className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    Cross-scope comparison: {comparisonSnapshot.processId} / {comparisonSnapshot.roundId} → {snapshot.processId} / {snapshot.roundId}
                  </div>
                )}
              <div className="mt-2 border">
                {diff.map((section) => (
                  <div
                    key={section.id}
                    className="border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs">{section.label}</span>
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>
                          {section.previousCount} → {section.nextCount}
                        </span>
                        <Badge
                          variant={
                            section.status === "changed" ? "default" : "outline"
                          }
                          className="rounded-sm text-[10px]"
                        >
                          {labelize(section.status)}
                        </Badge>
                      </div>
                    </div>
                    {section.changes.length > 0 && (
                      <ul className="mt-1 grid gap-0.5 text-[11px] text-muted-foreground">
                        {section.changes.map((change) => (
                          <li key={change}>{change}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <SnapshotContentsInspector snapshot={snapshot} diff={diff} />

            {snapshot.warnings.length > 0 && (
              <section>
                <div className="text-xs font-semibold">Warnings</div>
                <div className="mt-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                  <ul className="grid gap-1 text-xs text-amber-900 dark:text-amber-100">
                    {snapshot.warnings.map((warning) => (
                      <li key={`${warning.code}-${warning.message}`}>
                        {warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            <section>
              <div className="text-xs font-semibold">Pinned provenance</div>
              <div className="mt-2 break-all border px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
                <div>hash {snapshot.contentHash}</div>
                <div>profile {snapshot.profileRevisionId}</div>
                <div>compiler {snapshot.compilerVersion}</div>
                <div>playbook {snapshot.playbookRegistryVersion}</div>
                <div>
                  {snapshot.sourceManifest.statements.length} statements · {snapshot.sourceManifest.materials.length} materials · {snapshot.sourceManifest.kmbEntries.length} KMB entries
                </div>
              </div>
            </section>

            <SnapshotArtifactInspector snapshot={snapshot} />
          </div>
        )}
        {stale && (
          <div
            role="alert"
            className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            This snapshot differs from the current reviewed profile. Activation
            will restore its pinned reviewed content and will be rejected if any
            pinned authority is no longer valid.
          </div>
        )}
        {localError && (
          <div
            role="alert"
            className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {localError}
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={
              readOnly ||
              isChangingSelection ||
              !snapshot
            }
            variant={isActive ? "outline" : "default"}
            onClick={() => void (isActive ? deactivate() : activate(false))}
          >
            {isChangingSelection ? (
              <Loader2 className="size-4 animate-spin" />
            ) : isActive ? (
              <PowerOff className="size-4" />
            ) : (
              <Power className="size-4" />
            )}
            {isActive
              ? "Deactivate snapshot"
              : isRollback
                ? "Rollback to snapshot"
                : "Activate snapshot"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <Dialog
        open={confirmContextSwitch}
        onOpenChange={setConfirmContextSwitch}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch current Round and activate?</DialogTitle>
            <DialogDescription>
              Only one snapshot can be selected globally. The prior selection will
              be deactivated, while its immutable version and activation history
              remain available.
            </DialogDescription>
          </DialogHeader>
          {localError && (
            <div
              role="alert"
              className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {localError}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isChangingSelection}
              onClick={() => setConfirmContextSwitch(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isChangingSelection}
              onClick={() => void activate(true)}
            >
              {isChangingSelection ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              Switch and activate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};

const SnapshotMetric = ({ label, value }: { label: string; value: string }) => (
  <div className="bg-background px-3 py-2">
    <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
    <div className="mt-1 truncate text-xs font-medium">{value}</div>
  </div>
);

const SnapshotContentsInspector = ({
  snapshot,
  diff,
}: {
  snapshot: InterviewPreparationSnapshot;
  diff: PreparationSnapshotDiffSection[];
}) => {
  const diffById = new Map(diff.map((section) => [section.id, section]));
  const sections = [
    ["runtime-brief", "Runtime Brief", snapshot.runtimeBrief],
    ["strategy", "Preparation Strategy", snapshot.strategy],
    ["evidence", "Evidence Pack", snapshot.evidencePack],
    ["speech-bias", "Speech Bias Terms", snapshot.speechBiasTerms],
    ["opening", "Opening Pack", snapshot.openingPack],
    ["narratives", "Narrative Pack", snapshot.narrativePack],
    ["playbooks", "Playbook Overlays", snapshot.playbookOverlays],
    ["session-launch", "Session Launch Plan", snapshot.sessionLaunchPlan],
    ["warnings", "Warnings", snapshot.warnings],
    ["evidence-index", "Evidence Index", snapshot.evidenceIndex],
    ["source-manifest", "Source Manifest", snapshot.sourceManifest],
  ] as const;
  return (
    <section>
      <div className="text-xs font-semibold">Snapshot Inspector</div>
      <div className="mt-2 border">
        {sections.map(([id, label, value], index) => {
          const sectionDiff = diffById.get(id);
          return (
            <details
              key={id}
              open={index === 0}
              className="border-b last:border-b-0"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-muted/40">
                <span>{label}</span>
                <Badge
                  variant={sectionDiff?.status === "changed" ? "default" : "outline"}
                  className="rounded-sm text-[10px]"
                >
                  {labelize(sectionDiff?.status ?? "added")}
                </Badge>
              </summary>
              {sectionDiff?.changes.length ? (
                <ul className="border-t bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                  {sectionDiff.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              ) : null}
              <pre className="max-h-72 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-t bg-background px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
                {JSON.stringify(value, null, 2)}
              </pre>
            </details>
          );
        })}
      </div>
    </section>
  );
};

const SnapshotArtifactInspector = ({
  snapshot,
}: {
  snapshot: InterviewPreparationSnapshot;
}) => (
  <section>
    <div className="flex items-center justify-between gap-3">
      <div className="text-xs font-semibold">Artifact identity and provenance</div>
      <Badge variant="outline" className="rounded-sm text-[10px]">
        {snapshot.artifactManifest.artifacts.length} artifacts
      </Badge>
    </div>
    <div className="mt-2 max-h-80 overflow-y-auto border">
      {snapshot.artifactManifest.artifacts.map((artifact) => (
        <details key={artifact.artifactId} className="border-b last:border-b-0">
          <summary className="cursor-pointer list-none px-3 py-2 hover:bg-muted/40">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-mono text-[10px]">
                {artifact.artifactPath}
              </span>
              <Badge variant="outline" className="rounded-sm text-[9px]">
                {artifact.section}
              </Badge>
            </div>
          </summary>
          <div className="grid gap-1 border-t bg-muted/20 px-3 py-2 font-mono text-[10px] leading-4 text-muted-foreground">
            <div className="break-all">artifact {artifact.artifactId}</div>
            <div className="break-all">lineage {artifact.lineageKey}</div>
            <div className="break-all">content {artifact.contentHash}</div>
            <div className="mt-1 font-sans text-[10px] font-medium text-foreground/80">
              Sources
            </div>
            {artifact.sourceRefs.map((source) => (
              <div key={`${source.kind}:${source.id}`} className="break-all">
                {source.kind}:{source.id}
                {source.revision !== undefined ? `@r${source.revision}` : ""}
                {source.contentHash ? ` · ${source.contentHash}` : ""}
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  </section>
);

const StatementRow = ({
  statement,
  readOnly,
  onReview,
  onSources,
}: {
  statement: PreparationStatementWithSources;
  readOnly: boolean;
  onReview: () => void;
  onSources: () => void;
}) => (
  <div className="border-b px-3 py-3">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="rounded-sm text-[10px]">
            {labelize(statement.domain)}
          </Badge>
          <Badge
            variant={statement.status === "rejected" ? "destructive" : "secondary"}
            className="rounded-sm text-[10px]"
          >
            {labelize(statement.status)}
          </Badge>
        </div>
        <p className="mt-2 text-sm leading-5">{statement.content}</p>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {labelize(statement.ownership)} · {statement.sources.length} sources · r
          {statement.revision}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <Button size="icon" variant="ghost" title="Inspect sources" onClick={onSources}>
          <FileSearch className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Review statement"
          disabled={readOnly}
          onClick={onReview}
        >
          <Pencil className="size-4" />
        </Button>
      </div>
    </div>
  </div>
);

const ProfileView = ({
  profile,
  isCurrent,
  expanded,
}: {
  profile: InterviewPreparationProfileRevision;
  isCurrent: boolean;
  expanded: boolean;
}) => {
  const sections = [
    ["Logistics", profile.content.logistics],
    ["Evidence", profile.content.evidence],
    ["Terminology", profile.content.terminology],
    ["Strategy", profile.content.strategy],
    ["Company guidance", profile.content.companyGuidance],
    ["Interview policy", profile.content.interviewPolicy],
    ["Questions", profile.content.questions],
    ["Risks", profile.content.risks],
    ["Other", profile.content.other],
  ] as const;
  return (
    <div
      className={`${expanded ? "max-h-[calc(100vh-15rem)]" : "max-h-[580px]"} overflow-y-auto`}
    >
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>Revision {profile.revision}</span>
          <Badge variant={isCurrent ? "secondary" : "destructive"}>
            {isCurrent ? "Current" : "Recompose"}
          </Badge>
        </div>
        <span>{profile.confirmedStatementIds.length} confirmed</span>
      </div>
      {sections.map(([label, values]) => (
        <div key={label} className="border-b px-3 py-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span>{label}</span>
            <span className="text-muted-foreground">{values.length}</span>
          </div>
          {values.length > 0 && (
            <ul className="mt-2 grid gap-1.5 text-xs leading-4 text-muted-foreground">
              {values.map((value, index) => (
                <li key={`${label}-${index}`}>{value}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
};

const NarrativeGraphRow = ({
  graph,
  readOnly,
  onReview,
}: {
  graph: PreparationNarrativeGraph;
  readOnly: boolean;
  onReview: (node: PreparationNarrativeNode) => void;
}) => (
  <div className="border-b">
    <div className="flex items-center justify-between gap-2 bg-muted/20 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold">
          {labelize(graph.subjectKind)} · {graph.subjectId}
        </div>
        <div className="text-[11px] text-muted-foreground">
          Revision {graph.revision} · {graph.status}
        </div>
      </div>
      <Badge variant="outline" className="rounded-sm text-[10px]">
        {graph.nodes.length} nodes
      </Badge>
    </div>
    {graph.nodes.map((node) => (
      <button
        key={node.id}
        type="button"
        className="flex w-full items-start gap-2 border-t px-3 py-2 text-left hover:bg-muted/40 disabled:cursor-default"
        disabled={readOnly}
        onClick={() => onReview(node)}
      >
        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{node.title}</span>
            <span className="text-[10px] text-muted-foreground">
              {node.reviewStatus}
            </span>
          </div>
          <p className="mt-1 line-clamp-3 text-xs leading-4 text-muted-foreground">
            {node.contentDraft}
          </p>
        </div>
      </button>
    ))}
  </div>
);

const StatementReviewDialog = ({
  statement,
  readOnly,
  onOpenChange,
  onSave,
}: {
  statement?: PreparationStatementWithSources;
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: {
    status: "confirmed" | "rejected" | "unresolved" | "proposed";
    domain: PreparationStatementDomain;
    content: string;
    ownership: PreparationStatementOwnership;
    allowedWording?: string;
    prohibitedWording: string[];
    allowedInterviewFamilies: string[];
  }) => Promise<void>;
}) => {
  const [content, setContent] = useState("");
  const [domain, setDomain] = useState<PreparationStatementDomain>("unknown");
  const [ownership, setOwnership] = useState<PreparationStatementOwnership>(
    "unresolved"
  );
  const [allowedWording, setAllowedWording] = useState("");
  const [prohibitedWording, setProhibitedWording] = useState("");
  const [families, setFamilies] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    if (!statement) return;
    setContent(statement.content);
    setDomain(statement.domain);
    setOwnership(statement.ownership);
    setAllowedWording(statement.allowedWording ?? "");
    setProhibitedWording(statement.prohibitedWording.join("\n"));
    setFamilies(statement.allowedInterviewFamilies.join("\n"));
    setLocalError("");
  }, [statement]);

  const save = async (
    status: "confirmed" | "rejected" | "unresolved" | "proposed"
  ) => {
    if (
      status === "confirmed" &&
      ["candidate-fact", "project-evidence"].includes(domain) &&
      ownership === "unresolved"
    ) {
      setLocalError(
        "Choose Candidate, Team, Upstream, or Future ownership before confirming this statement."
      );
      return;
    }
    setLocalError("");
    setIsSaving(true);
    try {
      await onSave({
        status,
        domain,
        content,
        ownership,
        allowedWording: allowedWording.trim() || undefined,
        prohibitedWording: splitLines(prohibitedWording),
        allowedInterviewFamilies: splitLines(families),
      });
    } catch (reason) {
      setLocalError(errorMessage(reason));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(statement)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Review statement</DialogTitle>
          <DialogDescription>
            Confirmation makes this statement eligible for the draft profile. It
            still does not activate live interview behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium">
            Statement
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Domain
            <Select
              value={domain}
              onValueChange={(value) => {
                setDomain(value as PreparationStatementDomain);
                setLocalError("");
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PREPARATION_STATEMENT_DOMAINS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {labelize(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Ownership
            <Select
              value={ownership}
              onValueChange={(value) => {
                setOwnership(value as PreparationStatementOwnership);
                setLocalError("");
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[
                  "candidate-owned",
                  "team-owned",
                  "upstream-existing",
                  "future-design",
                  "unresolved",
                ].map((value) => (
                  <SelectItem key={value} value={value}>{labelize(value)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Allowed wording
            <Textarea value={allowedWording} onChange={(event) => setAllowedWording(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Prohibited wording · one per line
            <Textarea value={prohibitedWording} onChange={(event) => setProhibitedWording(event.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Interview families · one per line
            <Textarea value={families} onChange={(event) => setFamilies(event.target.value)} />
          </label>
        </div>
        {localError && (
          <div
            role="alert"
            className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {localError}
          </div>
        )}
        <DialogFooter className="flex-wrap sm:justify-between">
          <div className="flex gap-1">
            <Button size="icon" variant="outline" title="Reject" disabled={readOnly || isSaving} onClick={() => void save("rejected")}>
              <X className="size-4" />
            </Button>
            <Button size="icon" variant="outline" title="Keep unresolved" disabled={readOnly || isSaving} onClick={() => void save("unresolved")}>
              <CircleHelp className="size-4" />
            </Button>
          </div>
          <Button disabled={readOnly || isSaving || !content.trim()} onClick={() => void save("confirmed")}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const SourceDialog = ({
  statement,
  events,
  onOpenChange,
}: {
  statement?: PreparationStatementWithSources;
  events: PreparationStatementReviewEvent[];
  onOpenChange: (open: boolean) => void;
}) => (
  <Dialog open={Boolean(statement)} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Statement provenance</DialogTitle>
        <DialogDescription>
          Immutable source references and append-only review history.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div>
          <div className="mb-2 text-xs font-semibold">Sources</div>
          <div className="border">
            {statement?.sources.map((source) => (
              <div key={source.id} className="border-b px-3 py-2 last:border-b-0">
                <div className="text-xs font-medium">{source.title}</div>
                <div className="mt-0.5 break-all text-[11px] text-muted-foreground">
                  {source.sourceType} · {source.sourceId}
                  {source.page ? ` · page ${source.page}` : ""}
                </div>
                {source.preview && (
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-4 text-muted-foreground">
                    {source.preview}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold">Review events</div>
          <div className="border">
            {events.map((event) => (
              <div key={event.id} className="flex items-center justify-between border-b px-3 py-2 text-xs last:border-b-0">
                <span>{labelize(event.action)}</span>
                <span className="text-muted-foreground">r{event.statementRevision}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
);

const NarrativeCreateDialog = ({
  open,
  scope,
  profile,
  statements,
  route,
  processId,
  onOpenChange,
  onCreated,
  onError,
  abortRef,
}: {
  open: boolean;
  scope: PreparationConversationScope;
  profile?: InterviewPreparationProfileRevision;
  statements: PreparationStatementWithSources[];
  route: ReturnType<typeof interviewPreparationStatementProposalService.resolveRoute>;
  processId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
  onError: (message: string) => void;
  abortRef: React.MutableRefObject<AbortController | undefined>;
}) => {
  const [subjectKind, setSubjectKind] = useState<PreparationNarrativeSubjectKind>(
    "project"
  );
  const [subjectId, setSubjectId] = useState("");
  const [title, setTitle] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedIds(statements.map((statement) => statement.id));
  }, [open, statements]);

  const generate = async () => {
    if (!profile || route.status !== "ready") {
      onError(formatPreparationModelRouteError(route));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    try {
      const result = await interviewPreparationCompositionService.generateNarrative({
        processId,
        scope,
        profileRevisionId: profile.id,
        statementIds: selectedIds,
        subjectKind,
        subjectId,
        title,
        route,
        signal: controller.signal,
      });
      if (result.status === "committed") await onCreated();
      if (result.status === "stale") {
        onError("Narrative evidence changed before the model completed. Try again.");
      }
    } catch (reason) {
      if (!controller.signal.aborted) onError(errorMessage(reason));
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate narrative draft</DialogTitle>
          <DialogDescription>
            The model can use only the confirmed statements selected below.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium">
            Subject kind
            <Select value={subjectKind} onValueChange={(value) => setSubjectKind(value as PreparationNarrativeSubjectKind)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PREPARATION_NARRATIVE_SUBJECT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>{labelize(kind)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Stable subject id
            <Input value={subjectId} onChange={(event) => setSubjectId(event.target.value)} placeholder="agentic-memory" />
          </label>
          <label className="grid gap-1 text-xs font-medium sm:col-span-2">
            Display title
            <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Agentic Memory project story" />
          </label>
        </div>
        <div className="max-h-72 overflow-y-auto border">
          {statements.map((statement) => (
            <label key={statement.id} className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 text-xs last:border-b-0">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={selectedIds.includes(statement.id)}
                onChange={(event) =>
                  setSelectedIds((current) =>
                    event.target.checked
                      ? [...current, statement.id]
                      : current.filter((id) => id !== statement.id)
                  )
                }
              />
              <span>{statement.content}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={isGenerating || !subjectId.trim() || !title.trim() || !selectedIds.length || route.status !== "ready"}
            onClick={() => void generate()}
          >
            {isGenerating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const NarrativeReviewDialog = ({
  target,
  readOnly,
  onOpenChange,
  onSave,
  onError,
}: {
  target?: { graph: PreparationNarrativeGraph; node: PreparationNarrativeNode };
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (content: string, status: PreparationNarrativeReviewStatus) => Promise<void>;
  onError: (message: string) => void;
}) => {
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => setContent(target?.node.contentDraft ?? ""), [target]);
  const save = async (status: PreparationNarrativeReviewStatus) => {
    setIsSaving(true);
    try {
      await onSave(content, status);
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{target?.node.title ?? "Review narrative node"}</DialogTitle>
          <DialogDescription>
            Generated wording remains draft until this node is confirmed.
          </DialogDescription>
        </DialogHeader>
        <Textarea className="min-h-52" value={content} onChange={(event) => setContent(event.target.value)} />
        <DialogFooter className="flex-wrap sm:justify-between">
          <div className="flex gap-1">
            <Button size="icon" variant="outline" title="Reject" disabled={readOnly || isSaving} onClick={() => void save("rejected")}>
              <X className="size-4" />
            </Button>
            <Button size="icon" variant="outline" title="Keep unresolved" disabled={readOnly || isSaving} onClick={() => void save("unresolved")}>
              <CircleHelp className="size-4" />
            </Button>
          </div>
          <Button disabled={readOnly || isSaving || !content.trim()} onClick={() => void save("confirmed")}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const LoadingState = () => (
  <div className="flex justify-center py-10"><Loader2 className="size-4 animate-spin" /></div>
);

const EmptyState = ({ text }: { text: string }) => (
  <div className="px-4 py-10 text-center text-sm text-muted-foreground">{text}</div>
);

function parseScope(value: string): PreparationConversationScope {
  return value.startsWith("round:")
    ? { kind: "round", roundId: value.slice("round:".length) }
    : { kind: "process" };
}

function sameScope(left: PreparationConversationScope, right: PreparationConversationScope) {
  return left.kind === right.kind && (left.kind === "process" || (right.kind === "round" && left.roundId === right.roundId));
}

function resolveSnapshotComparison(input: {
  snapshot?: InterviewPreparationSnapshot;
  selectedSnapshot?: InterviewPreparationSnapshot;
  snapshots: InterviewPreparationSnapshot[];
}) {
  if (!input.snapshot) return undefined;
  if (input.selectedSnapshot?.id !== input.snapshot.id) {
    return input.selectedSnapshot;
  }
  return [...input.snapshots]
    .filter((candidate) => candidate.version < input.snapshot!.version)
    .sort((left, right) => right.version - left.version)[0];
}

function isConversationVisibleToScope(
  conversation: PreparationConversationScope,
  scope: PreparationConversationScope
) {
  return conversation.kind === "process" || sameScope(conversation, scope);
}

function splitLines(value: string) {
  return value.split(/\n|,/gu).map((item) => item.trim()).filter(Boolean);
}

function labelize(value: string) {
  return value.replace(/-/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
