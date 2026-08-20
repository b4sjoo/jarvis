export interface MemoryRebuildEntryIdentity {
  id: string;
  sourceIds: string[];
  projectId?: string;
}

export interface MemoryRebuildSourceIdentity {
  id: string;
  projectId?: string;
}

export interface MemoryRebuildRetentionPlan {
  disableEntryIds: string[];
  deleteEntryIds: string[];
  deleteSourceIds: string[];
  deleteProjectIds: string[];
}

export function planMemoryRebuildRetention(input: {
  currentEntries: MemoryRebuildEntryIdentity[];
  currentSources: MemoryRebuildSourceIdentity[];
  currentProjectIds: string[];
  existingEntries: MemoryRebuildEntryIdentity[];
  existingSources: MemoryRebuildSourceIdentity[];
  existingProjectIds: string[];
  snapshotLinkedEntryIds: string[];
}): MemoryRebuildRetentionPlan {
  const currentEntryIds = new Set(input.currentEntries.map((entry) => entry.id));
  const snapshotLinkedEntryIds = new Set(input.snapshotLinkedEntryIds);
  const staleEntries = input.existingEntries.filter(
    (entry) => !currentEntryIds.has(entry.id)
  );
  const retainedStaleEntries = staleEntries.filter((entry) =>
    snapshotLinkedEntryIds.has(entry.id)
  );

  const retainedSourceIds = new Set(
    input.currentSources.map((source) => source.id)
  );
  for (const entry of [...input.currentEntries, ...retainedStaleEntries]) {
    for (const sourceId of entry.sourceIds) retainedSourceIds.add(sourceId);
  }

  const retainedProjectIds = new Set(input.currentProjectIds);
  for (const entry of [...input.currentEntries, ...retainedStaleEntries]) {
    if (entry.projectId) retainedProjectIds.add(entry.projectId);
  }
  for (const source of input.currentSources) {
    if (source.projectId) retainedProjectIds.add(source.projectId);
  }
  for (const source of input.existingSources) {
    if (retainedSourceIds.has(source.id) && source.projectId) {
      retainedProjectIds.add(source.projectId);
    }
  }

  return {
    disableEntryIds: retainedStaleEntries.map((entry) => entry.id).sort(),
    deleteEntryIds: staleEntries
      .filter((entry) => !snapshotLinkedEntryIds.has(entry.id))
      .map((entry) => entry.id)
      .sort(),
    deleteSourceIds: input.existingSources
      .filter((source) => !retainedSourceIds.has(source.id))
      .map((source) => source.id)
      .sort(),
    deleteProjectIds: input.existingProjectIds
      .filter((projectId) => !retainedProjectIds.has(projectId))
      .sort(),
  };
}
