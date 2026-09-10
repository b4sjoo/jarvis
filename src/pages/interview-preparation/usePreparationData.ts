import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  interviewPreparationService,
  interviewPreparationMaterialService,
  interviewPreparationMaterialExtractionService,
  interviewPreparationConversationService,
  interviewPreparationStatementService,
  interviewPreparationCompositionService,
  interviewPreparationSnapshotService,
} from "../../lib/preparation/app-service";
import { subscribeToPreparationSnapshotSelectionChanges } from "../../lib/preparation/snapshot-selection-events";
import type { PreparationConversationScope } from "../../lib/preparation/conversation-types";
import { errorMessage, usePageOperation, usePageResource } from "./page-resource";

const services = {
  process: interviewPreparationService,
  material: interviewPreparationMaterialService,
  extraction: interviewPreparationMaterialExtractionService,
  conversation: interviewPreparationConversationService,
  statement: interviewPreparationStatementService,
  composition: interviewPreparationCompositionService,
  snapshot: interviewPreparationSnapshotService,
  subscribe: subscribeToPreparationSnapshotSelectionChanges,
};
const key = (...parts: unknown[]) => JSON.stringify(parts);

export function usePreparationData(processId?: string, api = services) {
  const view = useMemo(() => ({}), [processId]);
  const operation = usePageOperation(key(processId));
  const [message, setMessage] = useState<{ view: object; error?: string; notice?: string }>();
  const onError = useCallback((error: string) => {
    if (operation.isCurrent()) setMessage({ view, error: error || undefined });
  }, [operation.isCurrent, view]);
  const onNotice = useCallback((notice: string) => {
    if (operation.isCurrent()) setMessage({ view, notice: notice || undefined });
  }, [operation.isCurrent, view]);

  const processes = usePageResource("processes", () => api.process.list(true));
  const detail = usePageResource(processId && key(processId), () => api.process.get(processId!));
  const materials = usePageResource(processId && key(processId), () => api.material.list(processId!));
  const sessions = usePageResource(processId && key(processId), () => api.conversation.list(processId!));
  const currentContext = usePageResource("current-context", () => api.snapshot.getCurrentContext());
  const selectedSnapshot = usePageResource("selected-snapshot", () => api.snapshot.getCurrentSnapshot());

  const [chatSelection, setChatSelection] = useState<{ view: object; id?: string }>();
  const selectedSessionId = chatSelection?.view === view &&
    (!sessions.data || sessions.data.some((session) => session.id === chatSelection.id))
    ? chatSelection.id : undefined;
  const selectConversation = (id?: string) => setChatSelection({ view, id });
  const conversation = usePageResource(
    processId && selectedSessionId ? key(processId, selectedSessionId) : undefined,
    () => api.conversation.load(processId!, selectedSessionId!)
  );

  const activeRoundId = detail.data?.process.activeRoundId;
  const reviewView = useMemo(() => ({}), [view, activeRoundId]);
  const [reviewSelection, setReviewSelection] = useState<{ view: object; value: string }>();
  const scopeValue = reviewSelection?.view === reviewView
    ? reviewSelection.value : activeRoundId ? `round:${activeRoundId}` : "process";
  const selectReviewScope = (value: string) => setReviewSelection({ view: reviewView, value });
  const scope = useMemo<PreparationConversationScope>(() => scopeValue.startsWith("round:")
    ? { kind: "round", roundId: scopeValue.slice(6) } : { kind: "process" }, [scopeValue]);
  const roundId = scope.kind === "round" ? scope.roundId : undefined;
  const reviewKey = detail.data && processId ? key(processId, scope) : undefined;
  const statements = usePageResource(reviewKey, () => api.statement.list({ processId: processId!, roundId }));
  const profile = usePageResource(reviewKey, () => api.composition.getLatestProfile({ processId: processId!, scope }));
  const narratives = usePageResource(reviewKey, async () =>
    (await api.composition.listNarratives({ processId: processId!, roundId })).filter((graph) =>
      graph.scope.kind === scope.kind && (graph.scope.kind !== "round" || graph.scope.roundId === roundId)));
  const snapshots = usePageResource(reviewKey, () => roundId
    ? api.snapshot.list({ processId: processId!, roundId }) : Promise.resolve([]));

  const [materialSelection, setMaterialSelection] = useState<{ view: object; id?: string }>();
  const materialId = materialSelection?.view === view ? materialSelection.id : undefined;
  const inspectTarget = materials.data?.find((material) => material.id === materialId);
  const selectMaterial = (id?: string) => setMaterialSelection({ view, id });
  const inspection = usePageResource(inspectTarget && processId
    ? key(processId, inspectTarget.id, inspectTarget.updatedAt, inspectTarget.status) : undefined,
  () => api.extraction.inspect(processId!, materialId!));

  const [statementSelection, setStatementSelection] = useState<{ view: object; scopeValue: string; id?: string }>();
  const statementId = statementSelection?.view === reviewView && statementSelection.scopeValue === scopeValue ? statementSelection.id : undefined;
  const selectStatement = (id?: string) => setStatementSelection({ view: reviewView, scopeValue, id });
  const reviewEvents = usePageResource(processId && statementId
    ? key(processId, statementId) : undefined, () => api.statement.listEvents(processId!, statementId!));

  // Mutation callbacks retain their original query arguments, while the ref lets
  // them invalidate a revisited A without ever refreshing the currently viewed B.
  const current = useRef({ processId, scopeValue, selectedSessionId, materialId,
    detail, materials, sessions, conversation, statements, profile, narratives, snapshots, inspection, reviewEvents });
  useLayoutEffect(() => {
    current.current = { processId, scopeValue, selectedSessionId, materialId,
      detail, materials, sessions, conversation, statements, profile, narratives, snapshots, inspection, reviewEvents };
  });
  const refreshReviewed = useCallback(async () => {
    const now = current.current;
    if (now.processId !== processId || now.scopeValue !== scopeValue) return;
    await Promise.all([now.statements.refresh(), now.profile.refresh(), now.narratives.refresh(), now.snapshots.refresh(), now.reviewEvents.refresh()]);
  }, [processId, scopeValue]);
  const refreshStatements = useCallback(async (changedScope: PreparationConversationScope) => {
    const now = current.current;
    // Existing statement queries include process-wide statements in every round.
    if (now.processId !== processId || (changedScope.kind === "round" &&
      now.scopeValue !== `round:${changedScope.roundId}`)) return;
    await Promise.all([now.statements.refresh(), now.profile.refresh(), now.narratives.refresh(),
      now.snapshots.refresh(), now.reviewEvents.refresh()]);
  }, [processId]);
  const refreshMaterials = useCallback(async (changedMaterialId?: string) => {
    const now = current.current;
    if (now.processId !== processId) return;
    await Promise.all([now.materials.refresh(),
      changedMaterialId && now.materialId === changedMaterialId ? now.inspection.refresh() : Promise.resolve(),
      now.statements.refresh(), now.profile.refresh(), now.narratives.refresh(), now.snapshots.refresh()]);
  }, [processId]);
  const refreshConversation = useCallback(async (id?: string) => {
    const now = current.current;
    if (now.processId !== processId) return;
    await Promise.all([now.sessions.refresh(),
      id && now.selectedSessionId === id ? now.conversation.refresh() : Promise.resolve()]);
  }, [processId]);
  const refreshProcess = useCallback(async (id = processId, includeProcessResources = true) => {
    const now = current.current;
    await Promise.all([processes.refresh(), currentContext.refresh(), selectedSnapshot.refresh(),
      ...(includeProcessResources && now.processId === id ? [now.detail.refresh(), now.materials.refresh(), now.sessions.refresh(),
        now.conversation.refresh(), now.statements.refresh(), now.profile.refresh(), now.narratives.refresh(),
        now.snapshots.refresh(), now.inspection.refresh(), now.reviewEvents.refresh()] : [])]);
  }, [processId, processes.refresh, currentContext.refresh, selectedSnapshot.refresh]);
  const refreshSelection = useCallback(async () => {
    await Promise.all([currentContext.refresh(), selectedSnapshot.refresh(), current.current.snapshots.refresh()]);
  }, [currentContext.refresh, selectedSnapshot.refresh]);
  useEffect(() => api.subscribe(() => { void refreshSelection(); }, () => { void refreshSelection(); }), [api, refreshSelection]);

  useEffect(() => {
    if (!processId) return;
    let active = true;
    void api.extraction.resumeWorkspace(processId).catch((reason) => {
      if (active) onError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [api, processId, onError]);
  const extracting = materials.data?.some((material) => ["received", "extracting"].includes(material.status)) ?? false;
  useEffect(() => {
    if (!processId || !extracting) return;
    const timer = window.setInterval(() => { void materials.refresh(false); }, 750);
    return () => window.clearInterval(timer);
  }, [processId, extracting, materials.refresh]);
  useEffect(() => {
    if (!processId || !extracting) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.extraction.resumeWorkspace(processId).catch((reason) => {
        if (active) onError(errorMessage(reason));
      });
    }, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, processId, extracting, onError]);

  const error = [detail, processes, materials, sessions, conversation, currentContext,
    selectedSnapshot, statements, profile, narratives, snapshots, inspection, reviewEvents].find((resource) => resource.error)?.error;
  return { processes, detail, materials, sessions, currentContext, selectedSnapshot, conversation,
    statements, profile, narratives, snapshots, inspection, inspectTarget, reviewEvents,
    selectedSessionId, selectConversation, scope, scopeValue, selectReviewScope, selectMaterial, selectStatement,
    refreshProcess, refreshMaterials, refreshConversation, refreshReviewed, refreshStatements, refreshSelection,
    onError, onNotice, error: (message?.view === view ? message.error : undefined) ?? error,
    notice: message?.view === view ? message.notice : undefined, isCurrent: operation.isCurrent };
}

export type PreparationData = ReturnType<typeof usePreparationData>;
