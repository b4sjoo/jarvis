import { stablePreparationHash } from "./statement-proposal-service.js";
import type {
  InterviewPreparationSnapshot,
  PreparationSnapshotArtifactIdentity,
  PreparationSnapshotArtifactManifest,
  PreparationSnapshotArtifactSection,
  PreparationSnapshotArtifactSourceRef,
} from "./snapshot-types.js";

type SnapshotArtifactPayload = Pick<
  InterviewPreparationSnapshot,
  | "runtimeBrief"
  | "strategy"
  | "evidencePack"
  | "speechBiasTerms"
  | "openingPack"
  | "narrativePack"
  | "sessionLaunchPlan"
  | "playbookOverlays"
  | "evidenceIndex"
  | "sourceManifest"
  | "warnings"
>;

export function buildPreparationSnapshotArtifactManifest(input: {
  snapshotId: string;
  payload: SnapshotArtifactPayload;
  statementIdsByContent?: ReadonlyMap<string, readonly string[]>;
}): PreparationSnapshotArtifactManifest {
  const { payload } = input;
  const artifacts: PreparationSnapshotArtifactIdentity[] = [];
  const processRef = ref("process", payload.sourceManifest.process.id, {
    contentHash: payload.sourceManifest.process.contentHash,
  });
  const roundRef = ref("round", payload.sourceManifest.round.id, {
    contentHash: payload.sourceManifest.round.contentHash,
  });
  const profileRef = ref("profile", payload.sourceManifest.profile.id, {
    revision: payload.sourceManifest.profile.revision,
    contentHash: payload.sourceManifest.profile.contentHash,
  });
  const compilerRef = ref("compiler", payload.sourceManifest.compilerVersion);
  const statementPins = new Map(
    payload.sourceManifest.statements.map((pin) => [pin.id, pin])
  );
  const narrativePins = new Map(
    payload.sourceManifest.narrativeNodes.map((pin) => [
      `${pin.graphId}\u0000${pin.nodeId}`,
      pin,
    ])
  );

  const statementRefs = (ids: readonly string[]) =>
    ids.map((id) => {
      const pin = statementPins.get(id);
      return ref("statement", id, {
        revision: pin?.revision,
        contentHash: pin?.contentHash,
      });
    });
  const refsForText = (value: string) => {
    const statementIds = input.statementIdsByContent?.get(normalizeText(value));
    return statementIds?.length ? statementRefs(statementIds) : [profileRef];
  };
  const textKey = (value: string) => {
    const statementId = input.statementIdsByContent?.get(normalizeText(value))?.[0];
    return statementId ?? stablePreparationHash(normalizeText(value));
  };
  const add = (
    section: PreparationSnapshotArtifactSection,
    artifactPath: string,
    value: unknown,
    sourceRefs: PreparationSnapshotArtifactSourceRef[]
  ) => {
    const canonicalSources = dedupeSources(sourceRefs).sort(sourceOrder);
    const contentHash = stablePreparationHash(stableArtifactJson(value));
    const lineageKey = stablePreparationHash(
      stableArtifactJson({
        section,
        artifactPath,
        sources: canonicalSources.map(({ kind, id }) => ({ kind, id })),
      })
    );
    artifacts.push({
      artifactId: stablePreparationHash(
        stableArtifactJson({
          snapshotId: input.snapshotId,
          lineageKey,
          contentHash,
        })
      ),
      lineageKey,
      artifactPath,
      section,
      contentHash,
      sourceRefs: canonicalSources,
    });
  };

  for (const [key, value] of Object.entries(payload.runtimeBrief)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = String(item);
        add(
          "runtime-brief",
          `runtime-brief/${pathSegment(key)}/${pathSegment(textKey(text))}`,
          item,
          refsForText(text)
        );
      }
      continue;
    }
    add(
      "runtime-brief",
      `runtime-brief/${pathSegment(key)}`,
      value,
      key === "company" || key === "role"
        ? [processRef]
        : [roundRef, profileRef]
    );
  }

  for (const [key, values] of Object.entries(payload.strategy)) {
    for (const value of values) {
      add(
        "strategy",
        `strategy/${pathSegment(key)}/${pathSegment(textKey(value))}`,
        value,
        refsForText(value)
      );
    }
  }

  for (const item of payload.evidencePack.items) {
    add(
      "evidence",
      `evidence/${pathSegment(item.statementId)}`,
      item,
      statementRefs([item.statementId])
    );
  }

  for (const term of payload.speechBiasTerms) {
    add(
      "speech-bias",
      `speech-bias/${pathSegment(term.statementId)}`,
      term,
      statementRefs([term.statementId])
    );
  }

  for (const item of payload.openingPack.items) {
    const pin = narrativePins.get(`${item.graphId}\u0000${item.nodeId}`);
    add(
      "opening",
      `opening/${pathSegment(item.graphId)}/${pathSegment(item.nodeId)}`,
      item,
      [
        ref("narrative-node", item.nodeId, {
          revision: pin?.nodeRevision,
        }),
        ...statementRefs(item.statementIds),
      ]
    );
  }

  for (const graph of payload.narrativePack.graphs) {
    for (const node of graph.nodes) {
      const pin = narrativePins.get(`${graph.graphId}\u0000${node.nodeId}`);
      add(
        "narratives",
        `narratives/${pathSegment(graph.graphId)}/nodes/${pathSegment(node.nodeId)}`,
        node,
        [
          ref("narrative-node", node.nodeId, {
            revision: pin?.nodeRevision,
          }),
          ...statementRefs(node.statementIds),
        ]
      );
    }
    for (const edge of graph.edges) {
      add(
        "narratives",
        `narratives/${pathSegment(graph.graphId)}/edges/${pathSegment(edge.fromNodeId)}-${pathSegment(edge.relation)}-${pathSegment(edge.toNodeId)}`,
        edge,
        [
          ref("narrative-node", edge.fromNodeId),
          ref("narrative-node", edge.toNodeId),
        ]
      );
    }
  }

  for (const overlay of payload.playbookOverlays) {
    add(
      "playbooks",
      `playbooks/${pathSegment(overlay.expectedInterviewType)}`,
      overlay,
      [
        roundRef,
        profileRef,
        ref("canonical-playbook", overlay.canonicalPlaybookId),
        ...statementRefs(overlay.evidenceStatementIds),
      ]
    );
  }

  for (const [key, value] of Object.entries(payload.sessionLaunchPlan)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        add(
          "session-launch",
          `session-launch/${pathSegment(key)}/${pathSegment(stablePreparationHash(stableArtifactJson(item)))}`,
          item,
          [roundRef, compilerRef]
        );
      }
    } else {
      add(
        "session-launch",
        `session-launch/${pathSegment(key)}`,
        value,
        [roundRef, compilerRef]
      );
    }
  }

  for (const warning of payload.warnings) {
    add(
      "warnings",
      `warnings/${pathSegment(warning.code)}/${pathSegment(stablePreparationHash(warning.message))}`,
      warning,
      [profileRef, compilerRef]
    );
  }

  for (const item of payload.evidenceIndex) {
    const sourceRef = evidenceSourceRef(item);
    add(
      "evidence-index",
      `evidence-index/${pathSegment(item.sourceType)}/${pathSegment(item.sourceId)}`,
      item,
      [sourceRef]
    );
  }

  return {
    version: "preparation-artifact-manifest-v1",
    artifacts: artifacts.sort(
      (left, right) =>
        left.section.localeCompare(right.section) ||
        left.artifactPath.localeCompare(right.artifactPath)
    ),
  };
}

export function ensurePreparationSnapshotArtifactManifest(
  snapshot: Omit<InterviewPreparationSnapshot, "artifactManifest"> & {
    artifactManifest?: PreparationSnapshotArtifactManifest;
  }
): InterviewPreparationSnapshot {
  if (
    snapshot.artifactManifest?.version === "preparation-artifact-manifest-v1" &&
    Array.isArray(snapshot.artifactManifest.artifacts)
  ) {
    return snapshot as InterviewPreparationSnapshot;
  }
  return {
    ...snapshot,
    artifactManifest: buildPreparationSnapshotArtifactManifest({
      snapshotId: snapshot.id,
      payload: snapshot,
    }),
  };
}

function evidenceSourceRef(
  item: SnapshotArtifactPayload["evidenceIndex"][number]
): PreparationSnapshotArtifactSourceRef {
  switch (item.sourceType) {
    case "material-chunk":
      return ref("material-revision", item.materialRevisionId ?? item.sourceId, {
        contentHash: item.contentHash,
      });
    case "curated-kmb":
      return ref("curated-kmb", item.sourceId, { contentHash: item.contentHash });
    case "preparation-message":
      return ref("preparation-message", item.sourceId, {
        contentHash: item.contentHash,
      });
    case "user-confirmation":
      return ref("user-confirmation", item.sourceId, {
        contentHash: item.contentHash,
      });
  }
}

function ref(
  kind: PreparationSnapshotArtifactSourceRef["kind"],
  id: string,
  options: Pick<PreparationSnapshotArtifactSourceRef, "revision" | "contentHash"> = {}
): PreparationSnapshotArtifactSourceRef {
  return { kind, id, ...options };
}

function pathSegment(value: string) {
  return encodeURIComponent(value.replace(/\s+/gu, " ").trim());
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function dedupeSources(refs: PreparationSnapshotArtifactSourceRef[]) {
  const byKey = new Map<string, PreparationSnapshotArtifactSourceRef>();
  for (const source of refs) {
    byKey.set(`${source.kind}\u0000${source.id}`, source);
  }
  return [...byKey.values()];
}

function sourceOrder(
  left: PreparationSnapshotArtifactSourceRef,
  right: PreparationSnapshotArtifactSourceRef
) {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function stableArtifactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArtifactJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableArtifactJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
