import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@/components";
import {
  interviewPreparationMaterialService,
  interviewPreparationMaterialExtractionService,
  formatPreparationMaterialScope,
  formatPreparationMaterialType,
  materialsForActiveRound,
  type InterviewRound,
  type PreparationMaterial,
  type PreparationMaterialRevisionStatus,
  type PreparationExtractionInspection,
  type PreparationMaterialScope,
  type PreparationWorkspaceStatus,
} from "@/lib/preparation";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileImage,
  FileText,
  Info,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PROCESS_SCOPE = "workspace";

export const MaterialPanel = ({
  processId,
  processStatus,
  activeRoundId,
  rounds,
  materials,
  onChanged,
  onError,
  onNotice,
}: {
  processId: string;
  processStatus: PreparationWorkspaceStatus;
  activeRoundId?: string;
  rounds: InterviewRound[];
  materials: PreparationMaterial[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) => {
  const [addOpen, setAddOpen] = useState(false);
  const [scopeValue, setScopeValue] = useState(PROCESS_SCOPE);
  const [isImporting, setIsImporting] = useState(false);
  const [importFeedback, setImportFeedback] = useState<{
    added: string[];
    duplicates: string[];
    failures: string[];
  }>();
  const [deleteTarget, setDeleteTarget] = useState<PreparationMaterial>();
  const [inspectTarget, setInspectTarget] = useState<PreparationMaterial>();
  const [inspection, setInspection] = useState<PreparationExtractionInspection>();
  const [isInspecting, setIsInspecting] = useState(false);
  const [isRetryingExtraction, setIsRetryingExtraction] = useState(false);
  const [scopeEditTarget, setScopeEditTarget] = useState<PreparationMaterial>();
  const [scopeEditValue, setScopeEditValue] = useState(PROCESS_SCOPE);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdatingScope, setIsUpdatingScope] = useState(false);
  const [manualTextOpen, setManualTextOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [isSavingReview, setIsSavingReview] = useState(false);

  const roundTitles = useMemo(
    () => new Map(rounds.map((round) => [round.id, round.title])),
    [rounds]
  );
  const visibleMaterials = useMemo(
    () => materialsForActiveRound(materials, activeRoundId),
    [activeRoundId, materials]
  );
  const readOnly = processStatus !== "active";

  useEffect(() => {
    setScopeValue(PROCESS_SCOPE);
    setAddOpen(false);
    setImportFeedback(undefined);
    setDeleteTarget(undefined);
    setInspectTarget(undefined);
    setInspection(undefined);
    setScopeEditTarget(undefined);
    setManualTextOpen(false);
    setManualText("");
  }, [processId]);

  useEffect(() => {
    if (!inspectTarget) {
      setInspection(undefined);
      return;
    }
    let cancelled = false;
    setIsInspecting(true);
    void interviewPreparationMaterialExtractionService
      .inspect(processId, inspectTarget.id)
      .then((result) => {
        if (!cancelled) setInspection(result);
      })
      .catch((reason) => {
        if (!cancelled) onError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setIsInspecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectTarget, onError, processId]);

  useEffect(() => {
    if (!inspectTarget) return;
    const current = materials.find((material) => material.id === inspectTarget.id);
    if (
      current &&
      (current.status !== inspectTarget.status ||
        current.updatedAt !== inspectTarget.updatedAt)
    ) {
      setInspectTarget(current);
    }
  }, [inspectTarget, materials]);

  const chooseFiles = async () => {
    setIsImporting(true);
    setImportFeedback(undefined);
    onNotice("");
    try {
      const selection = await open({
        title: "Add interview preparation materials",
        multiple: true,
        directory: false,
        filters: [
          {
            name: "Preparation materials",
            extensions: [
              "pdf",
              "docx",
              "txt",
              "md",
              "markdown",
              "png",
              "jpg",
              "jpeg",
              "heic",
              "heif",
            ],
          },
        ],
      });
      if (!selection) return;
      const sourcePaths = Array.isArray(selection) ? selection : [selection];
      const outcomes = await interviewPreparationMaterialService.importPaths({
        workspaceId: processId,
        sourcePaths,
        scope: parseScope(scopeValue),
      });
      const imported = outcomes.filter((outcome) => outcome.status === "imported");
      const duplicates = outcomes.filter(
        (outcome) => outcome.status === "duplicate"
      );
      const failures = outcomes.filter((outcome) => outcome.status === "failed");
      void invoke("log_preparation_material_import_summary", {
        addedCount: imported.length,
        duplicateCount: duplicates.length,
        failedCount: failures.length,
      }).catch(() => {});

      await onChanged();
      if (duplicates.length || failures.length) {
        setImportFeedback({
          added: imported.map((outcome) =>
            outcome.status === "imported" ? outcome.material.displayName : ""
          ),
          duplicates: duplicates.map((outcome) =>
            outcome.status === "duplicate" ? outcome.existing.displayName : ""
          ),
          failures: failures.map((outcome) =>
            outcome.status === "failed" ? outcome.error : ""
          ),
        });
      } else {
        setAddOpen(false);
        onNotice(`${imported.length} added`);
      }
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsImporting(false);
    }
  };

  const deleteMaterial = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await interviewPreparationMaterialService.delete(
        processId,
        deleteTarget.id
      );
      setDeleteTarget(undefined);
      await onChanged();
      onNotice("Material deleted");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsDeleting(false);
    }
  };

  const updateMaterialScope = async () => {
    if (!scopeEditTarget) return;
    setIsUpdatingScope(true);
    try {
      const scope = parseScope(scopeEditValue);
      await interviewPreparationMaterialService.updateScope(
        processId,
        scopeEditTarget.id,
        scope
      );
      setScopeEditTarget(undefined);
      await onChanged();
      onNotice(
        `Material moved to ${formatPreparationMaterialScope(scope, roundTitles)}`
      );
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsUpdatingScope(false);
    }
  };

  const retryExtraction = async () => {
    if (!inspectTarget) return;
    setIsRetryingExtraction(true);
    try {
      const result = await interviewPreparationMaterialExtractionService.schedule(
        processId,
        inspectTarget.id,
        { force: true }
      );
      setInspection(result);
      await onChanged();
      onNotice("Material extraction completed");
    } catch (reason) {
      onError(errorMessage(reason));
      const result = await interviewPreparationMaterialExtractionService
        .inspect(processId, inspectTarget.id)
        .catch(() => undefined);
      setInspection(result);
      await onChanged();
    } finally {
      setIsRetryingExtraction(false);
    }
  };

  const refreshInspection = async () => {
    if (!inspectTarget) return undefined;
    const result = await interviewPreparationMaterialExtractionService.inspect(
      processId,
      inspectTarget.id
    );
    setInspection(result);
    await onChanged();
    return result;
  };

  const approveMaterial = async () => {
    if (!inspectTarget) return;
    setIsSavingReview(true);
    try {
      const approved = await interviewPreparationMaterialExtractionService.approve(
        processId,
        inspectTarget.id
      );
      if (!approved) {
        throw new Error("Material changed; reopen the details and retry.");
      }
      await refreshInspection();
      onNotice("Material marked ready");
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsSavingReview(false);
    }
  };

  const openManualText = () => {
    setManualText(
      inspection?.chunks.map((chunk) => chunk.content).join("\n\n") ?? ""
    );
    setManualTextOpen(true);
  };

  const saveManualText = async (markReady: boolean) => {
    if (!inspectTarget || !manualText.trim()) return;
    setIsSavingReview(true);
    try {
      await interviewPreparationMaterialExtractionService.commitManualText({
        workspaceId: processId,
        materialId: inspectTarget.id,
        text: manualText,
        markReady,
      });
      setManualTextOpen(false);
      await refreshInspection();
      onNotice(
        markReady
          ? "Manual material text saved and marked ready"
          : "Manual material text saved for review"
      );
    } catch (reason) {
      onError(errorMessage(reason));
    } finally {
      setIsSavingReview(false);
    }
  };

  return (
    <>
      <section className="border-b">
        <div className="flex h-12 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Materials</span>
            <Badge variant="outline">{visibleMaterials.length}</Badge>
          </div>
          <Button
            size="icon"
            variant="ghost"
            title="Add materials"
            disabled={readOnly}
            onClick={() => {
              setImportFeedback(undefined);
              setAddOpen(true);
            }}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        {visibleMaterials.length ? (
          <div className="max-h-64 overflow-y-auto">
            {visibleMaterials.map((material) => (
              <div
                key={material.id}
                className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0"
              >
                {material.mimeType.startsWith("image/") ? (
                  <FileImage className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <FileText className="mt-0.5 size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm font-medium"
                    title={material.displayName}
                  >
                    {material.displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{formatBytes(material.sizeBytes)}</span>
                    <span>·</span>
                    <span>
                      {formatPreparationMaterialScope(material.scope, roundTitles)}
                    </span>
                    <span>·</span>
                    <span>{formatExtractionStatus(material.status)}</span>
                  </div>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Material details"
                  onClick={() => setInspectTarget(material)}
                >
                  <Info className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Change material scope"
                  disabled={readOnly}
                  onClick={() => {
                    setScopeEditTarget(material);
                    setScopeEditValue(scopeToValue(material.scope));
                  }}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Delete material"
                  disabled={readOnly}
                  onClick={() => setDeleteTarget(material)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No materials for the active round
          </div>
        )}
      </section>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (open) setImportFeedback(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add preparation materials</DialogTitle>
            <DialogDescription>
              PDF, DOCX, text, Markdown, PNG, JPEG, or HEIC. Stored locally.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <span className="font-medium">Scope</span>
            <Select value={scopeValue} onValueChange={setScopeValue}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROCESS_SCOPE}>Entire process</SelectItem>
                {rounds.map((round) => (
                  <SelectItem key={round.id} value={`round:${round.id}`}>
                    {round.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {importFeedback && (
            <div
              aria-live="polite"
              className={`border px-3 py-2 text-sm ${
                importFeedback.failures.length
                  ? "border-destructive/30 bg-destructive/10"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}
            >
              {importFeedback.added.length > 0 && (
                <div className="font-medium">
                  Added {importFeedback.added.length}:{" "}
                  {importFeedback.added.join(", ")}
                </div>
              )}
              {importFeedback.duplicates.length > 0 && (
                <div className="font-medium">
                  Duplicate content skipped ({importFeedback.duplicates.length}).
                  Already stored as:{" "}
                  {importFeedback.duplicates.join(", ")}
                </div>
              )}
              {importFeedback.failures.map((failure, index) => (
                <div key={`${failure}-${index}`} className="text-destructive">
                  {failure}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={chooseFiles} disabled={isImporting}>
              {isImporting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Choose files
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(scopeEditTarget)}
        onOpenChange={(open) => {
          if (!open && !isUpdatingScope) setScopeEditTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change material scope</DialogTitle>
            <DialogDescription>
              Only the assignment changes. The original file, checksum, revision,
              and provenance stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <span className="font-medium">Scope</span>
            <Select value={scopeEditValue} onValueChange={setScopeEditValue}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PROCESS_SCOPE}>Entire process</SelectItem>
                {rounds.map((round) => (
                  <SelectItem key={round.id} value={`round:${round.id}`}>
                    {round.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isUpdatingScope}
              onClick={() => setScopeEditTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                isUpdatingScope ||
                !scopeEditTarget ||
                scopeEditValue === scopeToValue(scopeEditTarget.scope)
              }
              onClick={updateMaterialScope}
            >
              {isUpdatingScope && <Loader2 className="size-4 animate-spin" />}
              Save scope
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(inspectTarget)}
        onOpenChange={(open) => {
          if (!open && !isRetryingExtraction) setInspectTarget(undefined);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Material details</DialogTitle>
            <DialogDescription>
              Local provenance for this immutable original.
            </DialogDescription>
          </DialogHeader>
          {inspectTarget && (
            <div className="grid min-h-0 gap-4 overflow-y-auto pr-2">
              <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="break-words">{inspectTarget.originalFileName}</dd>
                <dt className="text-muted-foreground">Scope</dt>
                <dd>
                  {formatPreparationMaterialScope(inspectTarget.scope, roundTitles)}
                </dd>
                <dt className="text-muted-foreground">Type</dt>
                <dd>{formatPreparationMaterialType(inspectTarget)}</dd>
                <dt className="text-muted-foreground">Size</dt>
                <dd>{formatBytes(inspectTarget.sizeBytes)}</dd>
                <dt className="text-muted-foreground">Extraction</dt>
                <dd className="flex items-center gap-2">
                  {(isInspecting || inspectTarget.status === "extracting") && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  {formatExtractionStatus(
                    inspection?.candidate.status ?? inspectTarget.status
                  )}
                </dd>
                {inspection && (
                  <>
                    <dt className="text-muted-foreground">Review</dt>
                    <dd>
                      <Badge
                        variant="outline"
                        className={
                          inspection.candidate.reviewStatus === "needs-review"
                            ? "border-destructive/60 bg-destructive/10 text-destructive"
                            : ""
                        }
                      >
                        {formatReviewStatus(inspection.candidate.reviewStatus)}
                      </Badge>
                      {inspection.candidate.reviewActor
                        ? ` · ${inspection.candidate.reviewActor}`
                        : ""}
                    </dd>
                  </>
                )}
                {inspection?.candidate.metadata && (
                  <>
                    <dt className="text-muted-foreground">Method</dt>
                    <dd>{formatExtractionMethod(inspection.candidate.metadata.method)}</dd>
                    <dt className="text-muted-foreground">Output</dt>
                    <dd>
                      {inspection.candidate.metadata.textChars.toLocaleString()} chars
                      {inspection.candidate.metadata.pageCount
                        ? ` · ${inspection.candidate.metadata.pageCount} pages`
                        : ""}
                      {inspection.candidate.metadata.ocrPageCount
                        ? ` · ${inspection.candidate.metadata.ocrPageCount} OCR pages`
                        : ""}
                      {inspection.candidate.metadata.ocrAverageConfidence !==
                      undefined
                        ? ` · ${Math.round(
                            inspection.candidate.metadata.ocrAverageConfidence *
                              100
                          )}% OCR confidence`
                        : ""}
                      {` · ${inspection.candidate.metadata.chunkCount} chunks`}
                      {` · ${inspection.candidate.metadata.durationMs} ms`}
                    </dd>
                  </>
                )}
                <dt className="text-muted-foreground">SHA-256</dt>
                <dd className="break-all font-mono text-xs">
                  {inspectTarget.checksumSha256}
                </dd>
              </dl>

              {inspection?.candidate.metadata?.warningCodes.length ? (
                <div className="border-amber-500/30 bg-amber-500/10 border px-3 py-2 text-sm">
                  {inspection.candidate.metadata.warningCodes
                    .map(formatExtractionWarning)
                    .join(" · ")}
                  {inspection.candidate.metadata.error
                    ? `: ${inspection.candidate.metadata.error}`
                    : ""}
                </div>
              ) : null}

              {inspection?.candidate.qualitySignals.length ? (
                <div className="border-destructive/40 bg-destructive/10 border px-3 py-2 text-sm">
                  <div className="font-medium">Review signals</div>
                  {inspection.candidate.qualitySignals.map((signal) => (
                    <div key={`${signal.code}:${signal.page ?? ""}`} className="mt-1">
                      {signal.page ? `Page ${signal.page} · ` : ""}
                      {signal.detail}
                      {signal.confidence !== undefined
                        ? ` · ${Math.round(signal.confidence * 100)}% confidence`
                        : ""}
                    </div>
                  ))}
                </div>
              ) : null}

              {inspection?.chunks.length ? (
                <div className="grid gap-2">
                  <div className="text-sm font-medium">Extracted preview</div>
                  <div className="max-h-72 overflow-y-auto border px-3">
                    {inspection.chunks.slice(0, 12).map((chunk) => (
                      <div key={chunk.id} className="border-b py-3 last:border-b-0">
                        {(chunk.page || chunk.section || chunk.sourceMethod) && (
                          <div className="mb-1 text-xs text-muted-foreground">
                            {[
                              chunk.page ? `Page ${chunk.page}` : undefined,
                              chunk.section,
                              formatChunkSource(chunk.sourceMethod),
                              chunk.confidence !== undefined
                                ? `${Math.round(chunk.confidence * 100)}% confidence`
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        )}
                        <div className="whitespace-pre-wrap text-sm leading-6">
                          {chunk.content}
                        </div>
                      </div>
                    ))}
                  </div>
                  {inspection.chunks.length > 12 && (
                    <div className="text-xs text-muted-foreground">
                      Previewing 12 of {inspection.chunks.length} chunks
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
          {inspection && (
              <DialogFooter className="flex-wrap">
                {inspectTarget?.mimeType.startsWith("image/") && (
                  <Button
                    variant="outline"
                    onClick={openManualText}
                    disabled={isSavingReview || readOnly}
                  >
                    <Pencil className="size-4" />
                    Edit extracted content
                  </Button>
                )}
                {inspection.candidate.reviewStatus === "needs-review" && (
                  <Button
                    variant="outline"
                    onClick={approveMaterial}
                    disabled={isSavingReview || readOnly}
                  >
                    {isSavingReview && <Loader2 className="size-4 animate-spin" />}
                    Mark ready
                  </Button>
                )}
                {["extracting", "failed", "ready", "needs-review"].includes(
                  inspection.candidate.status
                ) && (
                <Button
                  onClick={retryExtraction}
                  disabled={isRetryingExtraction || isSavingReview || readOnly}
                >
                  {isRetryingExtraction && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {inspection.candidate.status === "extracting"
                    ? "Restart extraction"
                    : inspection.candidate.status === "failed"
                      ? "Retry extraction"
                      : "Re-run extraction"}
                </Button>
                )}
              </DialogFooter>
            )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={manualTextOpen}
        onOpenChange={(open) => !isSavingReview && setManualTextOpen(open)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit extracted material content</DialogTitle>
            <DialogDescription>
              This creates a new local revision. The immutable original and prior
              extraction remain preserved.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={manualText}
            onChange={(event) => setManualText(event.target.value)}
            placeholder="Enter the visible material content"
            className="min-h-80 resize-y font-mono text-sm"
          />
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isSavingReview}
              onClick={() => setManualTextOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              disabled={isSavingReview || !manualText.trim()}
              onClick={() => void saveManualText(false)}
            >
              Save for review
            </Button>
            <Button
              disabled={isSavingReview || !manualText.trim()}
              onClick={() => void saveManualText(true)}
            >
              {isSavingReview && <Loader2 className="size-4 animate-spin" />}
              Save and mark ready
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeleteTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete material?</DialogTitle>
            <DialogDescription>
              {deleteTarget?.displayName} will be removed from this process.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isDeleting}
              onClick={() => setDeleteTarget(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={deleteMaterial}
            >
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

function parseScope(value: string): PreparationMaterialScope {
  return value.startsWith("round:")
    ? { kind: "round", roundId: value.slice("round:".length) }
    : { kind: "workspace" };
}

function scopeToValue(scope: PreparationMaterialScope) {
  return scope.kind === "round" ? `round:${scope.roundId}` : PROCESS_SCOPE;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatExtractionStatus(
  status: PreparationMaterial["status"] | PreparationMaterialRevisionStatus
) {
  switch (status) {
    case "pending":
    case "received":
      return "Queued";
    case "extracting":
      return "Extracting";
    case "ready":
      return "Ready";
    case "needs-review":
      return "Needs review";
    case "unsupported":
      return "Unsupported";
    case "failed":
      return "Failed";
    case "deleted":
      return "Deleted";
  }
}

function formatExtractionMethod(method: string) {
  switch (method) {
    case "plain-text":
      return "Plain text";
    case "markdown":
      return "Markdown sections";
    case "docx-text":
      return "DOCX structure";
    case "pdf-text":
      return "Digital PDF pages";
    case "pdf-ocr":
      return "Local PDF OCR";
    case "pdf-hybrid-ocr":
      return "Digital PDF + local OCR";
    case "cloud-ocr":
      return "Preparation Model image text";
    case "multimodal-recovery":
      return "Preparation Model file recovery";
    case "manual-transcription":
      return "Manual transcription";
    default:
      return "No local text extractor";
  }
}

function formatExtractionWarning(code: string) {
  switch (code) {
    case "ocr-required":
      return "OCR is required and remains disabled";
    case "empty-extraction":
      return "No readable local text was found";
    case "empty-pages":
      return "One or more pages contained no readable text";
    case "text-truncated":
      return "Extraction exceeded the local safety budget";
    case "embedded-images-unread":
      return "Substantial embedded images were not included in local text extraction";
    case "ocr-applied":
      return "Local OCR supplemented embedded PDF image text";
    case "ocr-low-confidence":
      return "Some OCR text has low recognition confidence";
    case "ocr-page-budget-exceeded":
      return "The PDF exceeded the bounded OCR page budget";
    case "ocr-page-failed":
      return "One or more image-bearing PDF pages could not be OCR processed";
    case "pdf-page-extraction-failed":
      return "One or more PDF pages could not be extracted";
    case "pdf-page-parser-panic":
    case "pdf-parser-panic":
      return "The PDF parser recovered from malformed content";
    case "extraction-failed":
      return "Local extraction failed";
    case "cloud-ocr-unverified":
      return "Model-extracted image text requires review";
    case "multimodal-recovery-unverified":
      return "Model-recovered file text requires review";
    case "manual-transcription-unverified":
      return "Manual material text requires review";
    default:
      return code;
  }
}

function formatChunkSource(sourceMethod: string) {
  switch (sourceMethod) {
    case "pdf-ocr":
      return "OCR";
    case "pdf-text":
      return "Digital text";
    case "docx-text":
      return "DOCX text";
    case "markdown":
      return "Markdown";
    case "plain-text":
      return "Plain text";
    case "cloud-ocr":
      return "Model image text";
    case "multimodal-recovery":
      return "Model file recovery";
    case "manual-transcription":
      return "Manual transcription";
    default:
      return sourceMethod;
  }
}

function formatReviewStatus(status: PreparationExtractionInspection["candidate"]["reviewStatus"]) {
  switch (status) {
    case "unreviewed":
      return "Runtime accepted";
    case "needs-review":
      return "Needs review";
    case "approved":
      return "User approved";
  }
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
