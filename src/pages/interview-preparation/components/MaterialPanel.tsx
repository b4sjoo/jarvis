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
} from "@/components";
import {
  interviewPreparationMaterialService,
  formatPreparationMaterialScope,
  formatPreparationMaterialType,
  materialsForActiveRound,
  type InterviewRound,
  type PreparationMaterial,
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
  const [scopeEditTarget, setScopeEditTarget] = useState<PreparationMaterial>();
  const [scopeEditValue, setScopeEditValue] = useState(PROCESS_SCOPE);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isUpdatingScope, setIsUpdatingScope] = useState(false);

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
    setScopeEditTarget(undefined);
  }, [processId]);

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
                    <span>Stored</span>
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
          if (!open) setInspectTarget(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Material details</DialogTitle>
            <DialogDescription>
              Local provenance for this immutable original.
            </DialogDescription>
          </DialogHeader>
          {inspectTarget && (
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
              <dt className="text-muted-foreground">Status</dt>
              <dd>{inspectTarget.status}</dd>
              <dt className="text-muted-foreground">SHA-256</dt>
              <dd className="break-all font-mono text-xs">
                {inspectTarget.checksumSha256}
              </dd>
            </dl>
          )}
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

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
