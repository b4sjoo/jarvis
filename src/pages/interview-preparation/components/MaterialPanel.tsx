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
  type InterviewRound,
  type PreparationMaterial,
  type PreparationMaterialScope,
  type PreparationWorkspaceStatus,
} from "@/lib/preparation";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FileImage,
  FileText,
  Info,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const PROCESS_SCOPE = "workspace";

export const MaterialPanel = ({
  processId,
  processStatus,
  rounds,
  materials,
  onChanged,
  onError,
  onNotice,
}: {
  processId: string;
  processStatus: PreparationWorkspaceStatus;
  rounds: InterviewRound[];
  materials: PreparationMaterial[];
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) => {
  const [addOpen, setAddOpen] = useState(false);
  const [scopeValue, setScopeValue] = useState(PROCESS_SCOPE);
  const [isImporting, setIsImporting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PreparationMaterial>();
  const [inspectTarget, setInspectTarget] = useState<PreparationMaterial>();
  const [isDeleting, setIsDeleting] = useState(false);

  const roundTitles = useMemo(
    () => new Map(rounds.map((round) => [round.id, round.title])),
    [rounds]
  );
  const readOnly = processStatus !== "active";

  useEffect(() => {
    setScopeValue(PROCESS_SCOPE);
    setAddOpen(false);
    setDeleteTarget(undefined);
    setInspectTarget(undefined);
  }, [processId]);

  const chooseFiles = async () => {
    setIsImporting(true);
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

      await onChanged();
      setAddOpen(false);
      onNotice(
        [
          imported.length ? `${imported.length} added` : "",
          duplicates.length ? `${duplicates.length} duplicate` : "",
          failures.length ? `${failures.length} failed` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      );
      if (failures.length) {
        onError(
          failures
            .map((outcome) =>
              outcome.status === "failed" ? outcome.error : ""
            )
            .filter(Boolean)
            .join(" ")
        );
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

  return (
    <>
      <section className="border-b">
        <div className="flex h-12 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Materials</span>
            <Badge variant="outline">{materials.length}</Badge>
          </div>
          <Button
            size="icon"
            variant="ghost"
            title="Add materials"
            disabled={readOnly}
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-4" />
          </Button>
        </div>
        {materials.length ? (
          <div className="max-h-64 overflow-y-auto">
            {materials.map((material) => (
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
                    <span>{scopeLabel(material.scope, roundTitles)}</span>
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
            No materials
          </div>
        )}
      </section>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add preparation materials</DialogTitle>
            <DialogDescription>
              PDF, text, Markdown, PNG, JPEG, or HEIC. Stored locally.
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
              <dd>{scopeLabel(inspectTarget.scope, roundTitles)}</dd>
              <dt className="text-muted-foreground">Type</dt>
              <dd>{inspectTarget.mimeType}</dd>
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

function scopeLabel(
  scope: PreparationMaterialScope,
  roundTitles: Map<string, string>
) {
  return scope.kind === "workspace"
    ? "Process"
    : roundTitles.get(scope.roundId) ?? "Round";
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
