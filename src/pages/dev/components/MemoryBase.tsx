import { Badge, Button, Header, Input, Switch } from "@/components";
import {
  getMemoryEntries,
  getMemoryProjects,
  getMemorySources,
  rebuildCuratedMemoryIndex,
  setMemoryEntryEnabled,
} from "@/lib/database";
import type {
  MemoryEntry,
  MemoryImportSummary,
  MemoryProject,
  MemorySource,
} from "@/lib/memory";
import { cn } from "@/lib/utils";
import {
  BrainCircuitIcon,
  DatabaseIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

export const MemoryBase = () => {
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [projects, setProjects] = useState<MemoryProject[]>([]);
  const [query, setQuery] = useState("");
  const [selectedProject, setSelectedProject] = useState("all");
  const [summary, setSummary] = useState<MemoryImportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextSources, nextEntries, nextProjects] = await Promise.all([
        getMemorySources(),
        getMemoryEntries(),
        getMemoryProjects(),
      ]);
      setSources(nextSources);
      setEntries(nextEntries);
      setProjects(nextProjects);
      setError(null);
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to load memory index."
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rebuild = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSummary = await rebuildCuratedMemoryIndex();
      setSummary(nextSummary);
      await refresh();
    } catch (rebuildError) {
      setError(
        rebuildError instanceof Error
          ? rebuildError.message
          : "Failed to rebuild memory index."
      );
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return entries.filter((entry) => {
      if (selectedProject !== "all" && entry.projectId !== selectedProject) {
        return false;
      }

      if (!normalizedQuery) return true;

      const haystack = [
        entry.title,
        entry.summary,
        entry.content,
        entry.projectName,
        entry.tags.join(" "),
        entry.keywords.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [entries, query, selectedProject]);

  const enabledCount = entries.filter((entry) => entry.enabled).length;

  return (
    <section className="space-y-4 border-t border-border/60 pt-5">
      <Header
        title="Knowledge / Memory Base"
        description="Rebuild and inspect local curated memory entries used by Meeting Assistant."
        rightSlot={
          <Button onClick={rebuild} disabled={loading} size="sm">
            <RefreshCwIcon
              className={cn("h-4 w-4", loading && "animate-spin")}
            />
            Rebuild
          </Button>
        }
      />

      <div className="grid gap-2 sm:grid-cols-4">
        <MemoryStat
          icon={<DatabaseIcon className="h-3.5 w-3.5" />}
          label="Sources"
          value={sources.length}
        />
        <MemoryStat
          icon={<BrainCircuitIcon className="h-3.5 w-3.5" />}
          label="Entries"
          value={entries.length}
        />
        <MemoryStat label="Enabled" value={enabledCount} />
        <MemoryStat label="Projects" value={projects.length} />
      </div>

      {summary ? (
        <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs">
          <div className="font-medium">
            Imported {summary.entryCount} entries from {summary.draftCount} drafts
          </div>
          <div className="mt-1 text-muted-foreground">
            {summary.sourceCount} sources, {summary.projectCount} projects
            {summary.warnings.length ? `, ${summary.warnings.length} warnings` : ""}
          </div>
          {summary.warnings.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-muted-foreground">
                Warnings
              </summary>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {summary.warnings.slice(0, 8).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_220px]">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(value) => {
              setQuery(typeof value === "string" ? value : value.target.value);
            }}
            placeholder="Search memory entries"
            className="pl-9"
          />
        </div>
        <select
          value={selectedProject}
          onChange={(event) => setSelectedProject(event.target.value)}
          className="h-10 rounded-xl border border-input/50 bg-background px-3 text-sm outline-none"
        >
          <option value="all">All projects</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </div>

      <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
        {filteredEntries.length ? (
          filteredEntries.slice(0, 80).map((entry) => (
            <MemoryEntryRow
              key={entry.id}
              entry={entry}
              onEnabledChange={async (enabled) => {
                await setMemoryEntryEnabled(entry.id, enabled);
                await refresh();
              }}
            />
          ))
        ) : (
          <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
            No memory entries loaded yet.
          </div>
        )}
      </div>
    </section>
  );
};

const MemoryStat = ({
  icon,
  label,
  value,
}: {
  icon?: ReactNode;
  label: string;
  value: number;
}) => (
  <div className="rounded-md border border-border/70 p-3">
    <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase text-muted-foreground">
      {icon}
      {label}
    </div>
    <div className="mt-1 text-xl font-semibold">{value}</div>
  </div>
);

const MemoryEntryRow = ({
  entry,
  onEnabledChange,
}: {
  entry: MemoryEntry;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) => {
  const [updating, setUpdating] = useState(false);

  return (
    <div className="rounded-md border border-border/70 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{entry.title}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline">{entry.type}</Badge>
            <Badge variant="secondary">{entry.priority}</Badge>
            <Badge variant="outline">
              {entry.projectName || entry.projectId || entry.scope}
            </Badge>
            <Badge variant="outline">{entry.curationStatus}</Badge>
          </div>
        </div>
        <Switch
          checked={entry.enabled}
          disabled={updating}
          onCheckedChange={(enabled) => {
            setUpdating(true);
            void onEnabledChange(enabled).finally(() => setUpdating(false));
          }}
        />
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
        {entry.summary || entry.content}
      </p>
      <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
        {entry.id}
      </div>
    </div>
  );
};
