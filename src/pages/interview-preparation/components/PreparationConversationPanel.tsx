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
  Markdown,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components";
import { useApp } from "@/contexts";
import {
  formatPreparationModelRouteError,
  interviewPreparationConversationExecutionService,
  interviewPreparationConversationService,
  type InterviewProcessDetail,
  type PreparationConversation,
  type PreparationConversationDetail,
  type PreparationConversationScope,
  type PreparationMaterial,
  type PreparationMessage,
} from "@/lib/preparation";
import {
  ArrowLeft,
  Check,
  Files,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const PROCESS_SCOPE = "process";

export const PreparationConversationPanel = ({
  detail,
  materials,
  onError,
  onNotice,
  onMaterialsChanged,
  onDetailViewChange,
}: {
  detail: InterviewProcessDetail;
  materials: PreparationMaterial[];
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  onMaterialsChanged: () => Promise<void>;
  onDetailViewChange: (open: boolean) => void;
}) => {
  const { allAiProviders, selectedPreparationAIProvider } = useApp();
  const [sessions, setSessions] = useState<PreparationConversation[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [conversation, setConversation] =
    useState<PreparationConversationDetail>();
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [streamingResponse, setStreamingResponse] = useState("");
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [fileDialogSelection, setFileDialogSelection] = useState<string[]>([]);
  const [pendingRecoveryMaterialIds, setPendingRecoveryMaterialIds] = useState<
    string[]
  >([]);
  const [editingMessage, setEditingMessage] = useState<PreparationMessage>();
  const [sessionDialogMode, setSessionDialogMode] = useState<"create" | "edit">();
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionScopeValue, setSessionScopeValue] = useState(PROCESS_SCOPE);
  const [isSavingSession, setIsSavingSession] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PreparationConversation>();
  const [isDeletingSession, setIsDeletingSession] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const readOnly = detail.process.status !== "active";
  const selectedSession = sessions.find(
    (session) => session.id === selectedSessionId
  );
  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) =>
        isConversationScopeVisible(
          session.scope,
          detail.process.activeRoundId
        )
      ),
    [detail.process.activeRoundId, sessions]
  );
  const sessionScope = selectedSession?.scope;
  const scopedMaterials = useMemo(
    () =>
      sessionScope
        ? materials.filter(
            (material) =>
              material.status !== "deleted" &&
              isMaterialScopeVisible(material, sessionScope)
          )
        : [],
    [materials, sessionScope]
  );
  const pendingRecoveryMaterials = useMemo(
    () =>
      pendingRecoveryMaterialIds
        .map((materialId) =>
          scopedMaterials.find((material) => material.id === materialId)
        )
        .filter((material): material is PreparationMaterial => Boolean(material)),
    [pendingRecoveryMaterialIds, scopedMaterials]
  );
  const recoveryRequiresVision = pendingRecoveryMaterials.some(
    (material) =>
      material.mimeType.startsWith("image/") ||
      material.mimeType === "application/pdf"
  );
  const route = interviewPreparationConversationExecutionService.resolveRoute({
    providers: allAiProviders,
    selectedProvider: selectedPreparationAIProvider,
    requiresVision: recoveryRequiresVision,
  });
  const fileDisabledReason = readOnly
    ? "Archived processes are read-only"
    : !scopedMaterials.length
      ? "Upload a material to this conversation's scope first"
      : undefined;

  const refreshSessions = useCallback(async () => {
    setIsLoading(true);
    try {
      setSessions(
        await interviewPreparationConversationService.list(detail.process.id)
      );
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsLoading(false);
    }
  }, [detail.process.id, onError]);

  const loadConversation = useCallback(async () => {
    if (!selectedSessionId) {
      setConversation(undefined);
      return;
    }
    try {
      setConversation(
        await interviewPreparationConversationService.load(
          detail.process.id,
          selectedSessionId
        )
      );
    } catch (reason) {
      onError(errorMessage(reason));
      setSelectedSessionId(undefined);
      setConversation(undefined);
    }
  }, [detail.process.id, onError, selectedSessionId]);

  useEffect(() => {
    abortRef.current?.abort();
    setSelectedSessionId(undefined);
    setConversation(undefined);
    setPendingRecoveryMaterialIds([]);
    setFileDialogSelection([]);
    setFileDialogOpen(false);
    setEditingMessage(undefined);
    setStreamingResponse("");
    setDraft("");
    void refreshSessions();
  }, [detail.process.id, refreshSessions]);

  useEffect(() => {
    void loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    onDetailViewChange(Boolean(selectedSessionId));
  }, [onDetailViewChange, selectedSessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [conversation?.messages.length, streamingResponse]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    []
  );

  const openCreateDialog = () => {
    setSessionDialogMode("create");
    setSessionTitle("");
    setSessionScopeValue(
      detail.process.activeRoundId
        ? `round:${detail.process.activeRoundId}`
        : PROCESS_SCOPE
    );
  };

  const openEditDialog = (session: PreparationConversation) => {
    setSessionDialogMode("edit");
    setSessionTitle(session.title);
    setSessionScopeValue(formatScopeValue(session.scope));
  };

  const saveSession = async () => {
    if (!sessionDialogMode) return;
    setIsSavingSession(true);
    try {
      const scope = parseScope(sessionScopeValue);
      let targetSessionId = selectedSession?.id;
      const remainsVisible = isConversationScopeVisible(
        scope,
        detail.process.activeRoundId
      );
      if (sessionDialogMode === "create") {
        const created = await interviewPreparationConversationService.create({
          processId: detail.process.id,
          scope,
          title: sessionTitle,
        });
        targetSessionId = created.id;
        setSelectedSessionId(created.id);
      } else if (selectedSession) {
        await interviewPreparationConversationService.updateMetadata({
          processId: detail.process.id,
          conversationId: selectedSession.id,
          title: sessionTitle,
          scope,
        });
      }
      setSessionDialogMode(undefined);
      await refreshSessions();
      if (remainsVisible && targetSessionId) {
        setSelectedSessionId(targetSessionId);
        setConversation(
          await interviewPreparationConversationService.load(
            detail.process.id,
            targetSessionId
          )
        );
      } else {
        setSelectedSessionId(undefined);
        setConversation(undefined);
        const targetRound =
          scope.kind === "round"
            ? detail.rounds.find((round) => round.id === scope.roundId)
            : undefined;
        onNotice(
          `Conversation moved to ${targetRound?.title ?? "another round"}. Switch the active round to reopen it.`
        );
      }
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsSavingSession(false);
    }
  };

  const deleteSession = async () => {
    if (!deleteTarget) return;
    setIsDeletingSession(true);
    try {
      await interviewPreparationConversationService.delete(
        detail.process.id,
        deleteTarget.id
      );
      if (selectedSessionId === deleteTarget.id) {
        setSelectedSessionId(undefined);
        setConversation(undefined);
      }
      setDeleteTarget(undefined);
      await refreshSessions();
      onNotice("Preparation conversation deleted");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsDeletingSession(false);
    }
  };

  const stageFileRecovery = () => {
    if (!fileDialogSelection.length) return;
    setEditingMessage(undefined);
    setPendingRecoveryMaterialIds(fileDialogSelection);
    setFileDialogOpen(false);
    if (!draft.trim()) {
      setDraft(
        fileDialogSelection.length === 1
          ? "Extract all visible text and recover the document structure from this file."
          : "Extract all visible text and recover the document structure from these files."
      );
    }
  };

  const openFileDialog = () => {
    setFileDialogSelection(pendingRecoveryMaterialIds);
    setFileDialogOpen(true);
  };

  const toggleFileSelection = (materialId: string) => {
    setFileDialogSelection((current) =>
      current.includes(materialId)
        ? current.filter((id) => id !== materialId)
        : current.length < 6
          ? [...current, materialId]
          : current
    );
  };

  const startEditingMessage = (message: PreparationMessage) => {
    setPendingRecoveryMaterialIds([]);
    setEditingMessage(message);
    setDraft(message.content);
  };

  const cancelEditingMessage = () => {
    setEditingMessage(undefined);
    setDraft("");
  };

  const send = async () => {
    const content = draft.trim();
    if (
      !content ||
      !selectedSessionId ||
      !sessionScope ||
      isSending ||
      readOnly
    ) {
      return;
    }
    if (route.status !== "ready") {
      onError(formatPreparationModelRouteError(route));
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsSending(true);
    setStreamingResponse("");
    onError("");
    const editing = editingMessage;
    const optimistic: PreparationMessage = {
      id: `optimistic-${Date.now()}`,
      conversationId: selectedSessionId,
      logicalTurnId: `optimistic-${Date.now()}`,
      role: "user",
      content,
      materialRefs: pendingRecoveryMaterialIds,
      sourceRefs: [],
      createdAt: Date.now(),
    };
    setConversation((current) => {
      if (!current) return current;
      if (!editing) {
        return { ...current, messages: [...current.messages, optimistic] };
      }
      const targetIndex = current.messages.findIndex(
        (message) => message.id === editing.id
      );
      return {
        ...current,
        messages: [
          ...current.messages.slice(0, Math.max(0, targetIndex)),
          optimistic,
        ],
      };
    });
    setDraft("");
    setEditingMessage(undefined);

    try {
      const result =
        await interviewPreparationConversationExecutionService.execute({
          processId: detail.process.id,
          conversationId: selectedSessionId,
          content,
          route,
          recovery: pendingRecoveryMaterialIds.length
            ? { materialIds: pendingRecoveryMaterialIds }
            : undefined,
          editMessageId: editing?.id,
          signal: controller.signal,
          onDelta: setStreamingResponse,
        });
      if (result.status === "stale") {
        onNotice("A newer preparation request replaced this response.");
      } else if (result.status === "committed" && result.postCommitWarning) {
        onNotice(
          `Response saved. Material recovery needs attention: ${result.postCommitWarning}`
        );
      }
      if (result.status === "committed") {
        setPendingRecoveryMaterialIds([]);
        await onMaterialsChanged();
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        onError(errorMessage(reason));
        setDraft(content);
        setEditingMessage(editing);
      }
    } finally {
      setStreamingResponse("");
      setIsSending(false);
      if (abortRef.current === controller) abortRef.current = undefined;
      await loadConversation();
      await refreshSessions();
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectedSession ? (
        <>
          <div className="flex min-h-12 items-center justify-between gap-2 border-b px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                title="Back to preparation conversations"
                disabled={isSending}
                onClick={() => setSelectedSessionId(undefined)}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">
                  {selectedSession.title}
                </div>
                <div className="text-xs text-muted-foreground">
                  {scopeLabel(selectedSession.scope, detail)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Badge variant="outline" className="max-w-36 truncate">
                {selectedPreparationAIProvider.provider || "No model"}
              </Badge>
              {!readOnly && (
                <Button
                  size="icon"
                  variant="ghost"
                  title="Edit conversation"
                  disabled={isSending}
                  onClick={() => openEditDialog(selectedSession)}
                >
                  <Pencil className="size-4" />
                </Button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {conversation?.messages.length || streamingResponse ? (
              <div>
                {conversation?.messages.map((message) => (
                  <PreparationMessageView
                    key={message.id}
                    message={message}
                    canEdit={
                      !readOnly &&
                      !isSending &&
                      message.role === "user" &&
                      !message.requestMetadata?.image &&
                      !message.requestMetadata?.recovery
                    }
                    onEdit={() => startEditingMessage(message)}
                  />
                ))}
                {isSending && (
                  <div className="border-b px-5 py-4">
                    <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin" /> Jarvis
                    </div>
                    {streamingResponse ? (
                      <div className="text-sm leading-6">
                        <Markdown isStreaming>{streamingResponse}</Markdown>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        Reading bounded preparation context…
                      </div>
                    )}
                  </div>
                )}
                <div ref={endRef} />
              </div>
            ) : (
              <div className="flex h-full min-h-72 items-center justify-center px-6 text-sm text-muted-foreground">
                Start this preparation conversation
              </div>
            )}
          </div>

          <div className="border-t p-3">
            {editingMessage && (
              <div className="mb-2 flex items-center gap-2 border px-2 py-1.5 text-xs">
                <Pencil className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Editing this message will replace the later visible conversation
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  title="Cancel edit"
                  onClick={cancelEditingMessage}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
            {pendingRecoveryMaterials.length > 0 && (
              <div className="mb-2 flex items-start gap-2 border px-2 py-1.5 text-xs">
                <Files className="mt-0.5 size-3.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">File recovery</div>
                  <div className="mt-0.5 truncate text-muted-foreground">
                    {pendingRecoveryMaterials
                      .map((material) => material.displayName)
                      .join(", ")}
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  title="Remove selected files"
                  onClick={() => setPendingRecoveryMaterialIds([])}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <span title={fileDisabledReason}>
                <Button
                  size="icon"
                  variant="outline"
                  title={fileDisabledReason ?? "Select files for recovery"}
                  disabled={Boolean(fileDisabledReason) || isSending}
                  onClick={openFileDialog}
                >
                  <Files className="size-4" />
                </Button>
              </span>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                disabled={readOnly || isSending}
                placeholder={
                  readOnly
                    ? "Archived process"
                    : editingMessage
                      ? "Edit your message…"
                      : "Ask about this interview process…"
                }
                className="max-h-40 min-h-10 resize-y rounded-md"
              />
              {isSending ? (
                <Button
                  size="icon"
                  variant="outline"
                  title="Cancel response"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square className="size-4 fill-current" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  title={editingMessage ? "Save edit and regenerate" : "Send"}
                  disabled={readOnly || !draft.trim() || route.status !== "ready"}
                  onClick={() => void send()}
                >
                  <Send className="size-4" />
                </Button>
              )}
            </div>
            {route.status !== "ready" && !readOnly && (
              <div className="mt-2 text-xs text-destructive">
                {formatPreparationModelRouteError(route)}
              </div>
            )}
            {fileDisabledReason && !readOnly && (
              <div className="mt-2 text-xs text-muted-foreground">
                File recovery unavailable: {fileDisabledReason}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex h-12 items-center justify-between border-b px-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquare className="size-4" /> Preparation Conversation
              <Badge variant="outline">{visibleSessions.length}</Badge>
            </div>
            <Button
              size="icon"
              variant="ghost"
              title="New preparation conversation"
              disabled={readOnly}
              onClick={openCreateDialog}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex min-h-72 items-center justify-center">
                <Loader2 className="size-4 animate-spin" />
              </div>
            ) : visibleSessions.length ? (
              visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center border-b last:border-b-0"
                >
                  <button
                    className="min-w-0 flex-1 px-4 py-3 text-left hover:bg-muted/60"
                    onClick={() => setSelectedSessionId(session.id)}
                  >
                    <div className="truncate text-sm font-medium">
                      {session.title}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{scopeLabel(session.scope, detail)}</span>
                      <span>·</span>
                      <span>{formatUpdatedAt(session.updatedAt)}</span>
                    </div>
                  </button>
                  {!readOnly && (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        title="Edit conversation"
                        onClick={() => {
                          setSelectedSessionId(session.id);
                          openEditDialog(session);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="mr-2"
                        title="Delete conversation"
                        onClick={() => setDeleteTarget(session)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-6 text-center">
                <div className="text-sm text-muted-foreground">
                  No preparation conversations for the active scope
                </div>
                {!readOnly && (
                  <Button size="sm" onClick={openCreateDialog}>
                    <Plus className="size-4" /> New conversation
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <Dialog
        open={fileDialogOpen}
        onOpenChange={(open) => !isSending && setFileDialogOpen(open)}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Select materials for recovery</DialogTitle>
            <DialogDescription>
              Select up to 6 files visible to this conversation. Model-recovered
              text is saved as a new revision and remains unapproved until you
              review it.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto border">
            {scopedMaterials.map((material) => {
              const selected = fileDialogSelection.includes(material.id);
              const disabled = !selected && fileDialogSelection.length >= 6;
              return (
                <button
                  key={material.id}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  disabled={disabled}
                  className="flex w-full items-center gap-3 border-b px-3 py-3 text-left last:border-b-0 hover:bg-muted/50 disabled:opacity-50"
                  onClick={() => toggleFileSelection(material.id)}
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/50"}`}
                  >
                    {selected && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {material.displayName}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {scopeLabelForMaterial(material, detail)} · {material.mimeType}
                    </span>
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      material.status === "needs-review"
                        ? "border-destructive/60 bg-destructive/10 text-destructive"
                        : ""
                    }
                  >
                    {material.status === "needs-review"
                      ? "Needs review"
                      : material.status}
                  </Badge>
                </button>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFileDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!fileDialogSelection.length}
              onClick={stageFileRecovery}
            >
              Attach {fileDialogSelection.length || ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(sessionDialogMode)}
        onOpenChange={(open) => !open && setSessionDialogMode(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {sessionDialogMode === "create"
                ? "New preparation conversation"
                : "Edit preparation conversation"}
            </DialogTitle>
            <DialogDescription>
              The scope controls which round-specific materials can enter this chat.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <label className="block space-y-1.5 text-sm">
              <span>Title</span>
              <Input
                value={sessionTitle}
                onChange={(event) => setSessionTitle(event.target.value)}
                placeholder="Generated from the first message"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Scope</span>
              <Select
                value={sessionScopeValue}
                onValueChange={setSessionScopeValue}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PROCESS_SCOPE}>Entire process</SelectItem>
                  {detail.rounds.map((round) => (
                    <SelectItem key={round.id} value={`round:${round.id}`}>
                      {round.title}
                      {round.id === detail.process.activeRoundId
                        ? " (active)"
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSessionDialogMode(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                isSavingSession ||
                (sessionDialogMode === "edit" && !sessionTitle.trim())
              }
              onClick={() => void saveSession()}
            >
              {isSavingSession && <Loader2 className="size-4 animate-spin" />}
              {sessionDialogMode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete preparation conversation?</DialogTitle>
            <DialogDescription>
              This removes the conversation and every local message branch inside it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(undefined)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeletingSession}
              onClick={() => void deleteSession()}
            >
              {isDeletingSession && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const PreparationMessageView = ({
  message,
  canEdit,
  onEdit,
}: {
  message: PreparationMessage;
  canEdit: boolean;
  onEdit: () => void;
}) => {
  const snapshot = message.contextSnapshot;
  return (
    <div
      className={`border-b px-5 py-4 ${message.role === "user" ? "bg-muted/30" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span>{message.role === "assistant" ? "Jarvis" : "You"}</span>
        {message.role === "user" && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title={
              canEdit
                ? "Edit this message"
                : message.requestMetadata?.image || message.requestMetadata?.recovery
                  ? "File-recovery requests cannot be edited in place"
                  : "Message editing is unavailable while generating"
            }
            disabled={!canEdit}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="text-sm leading-6">
        {message.role === "assistant" ? (
          <Markdown>{message.content}</Markdown>
        ) : (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
      </div>
      {snapshot && (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {snapshot.sourceRefs.length} sources ·{" "}
            {formatCompactChars(snapshot.budget.totalChars)} / 30k context
          </summary>
          <div className="mt-2 border-l pl-3">
            {snapshot.sourceRefs.length ? (
              snapshot.sourceRefs.map((source) => (
                <div key={`${source.kind}:${source.id}`} className="py-1">
                  <span className="font-medium text-foreground/80">
                    {source.title}
                  </span>
                  {source.page ? ` · page ${source.page}` : ""}
                  {source.section ? ` · ${source.section}` : ""}
                  {source.availableChunks
                    ? ` · ${source.coveredChunks ?? 0}/${source.availableChunks} chunks sampled`
                    : ""}
                  {source.warningCodes?.length
                    ? ` · ${source.warningCodes.join(", ")}`
                    : ""}
                </div>
              ))
            ) : (
              <div className="py-1">No material or KMB source selected</div>
            )}
            {snapshot.budget.truncationReasons.length > 0 && (
              <div className="py-1">
                Budget: {snapshot.budget.truncationReasons.join(", ")}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
};

function parseScope(value: string): PreparationConversationScope {
  return value.startsWith("round:")
    ? { kind: "round", roundId: value.slice("round:".length) }
    : { kind: "process" };
}

function formatScopeValue(scope: PreparationConversationScope) {
  return scope.kind === "round" ? `round:${scope.roundId}` : PROCESS_SCOPE;
}

function isConversationScopeVisible(
  scope: PreparationConversationScope,
  activeRoundId: string | undefined
) {
  return (
    scope.kind === "process" ||
    (Boolean(activeRoundId) && scope.roundId === activeRoundId)
  );
}

function isMaterialScopeVisible(
  material: PreparationMaterial,
  scope: PreparationConversationScope
) {
  return (
    material.scope.kind === "workspace" ||
    (scope.kind === "round" &&
      material.scope.kind === "round" &&
      material.scope.roundId === scope.roundId)
  );
}

function scopeLabelForMaterial(
  material: PreparationMaterial,
  detail: InterviewProcessDetail
) {
  if (material.scope.kind === "workspace") return "Entire process";
  const roundId = material.scope.roundId;
  return (
    detail.rounds.find((round) => round.id === roundId)?.title ??
    "Interview round"
  );
}

function scopeLabel(
  scope: PreparationConversationScope,
  detail: InterviewProcessDetail
) {
  if (scope.kind === "process") return "Entire process";
  return (
    detail.rounds.find((round) => round.id === scope.roundId)?.title ??
    "Interview round"
  );
}

function formatUpdatedAt(timestamp: number) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCompactChars(chars: number) {
  return chars >= 1_000 ? `${(chars / 1_000).toFixed(1)}k` : String(chars);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
