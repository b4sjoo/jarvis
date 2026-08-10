import {
  interviewProcessRepository,
  preparationConversationRepository,
  preparationCompositionRepository,
  preparationMaterialContextRepository,
  preparationMaterialExtractionRepository,
  preparationMaterialRepository,
  preparationStatementRepository,
  preparationSnapshotRepository,
  preparationWorkspaceRepository,
  getMemoryEntries,
} from "../database/index";
import { createInterviewProcessService } from "./interview-process-service";
import { tauriPreparationWorkspaceStorage } from "./tauri-storage";
import { tauriPreparationMaterialStorage } from "./material-tauri-storage";
import { createPreparationMaterialService } from "./material-service";
import { createPreparationMaterialExtractionService } from "./material-extraction-service";
import { tauriPreparationMaterialExtraction } from "./material-extraction-tauri";
import { createPreparationWorkspaceService } from "./workspace-service";
import { createPreparationConversationService } from "./conversation-service";
import { createPreparationContextComposer } from "./context-composer";
import { createPreparationConversationExecutionService } from "./conversation-execution";
import { tauriPreparationMaterialImage } from "./material-image-tauri";
import { invoke } from "@tauri-apps/api/core";
import { fetchAIResponse } from "../functions/ai-response.function";
import { retrieveMemoryContext } from "../memory/retrieval";
import { createPreparationStatementService } from "./statement-service";
import { createPreparationStatementProposalService } from "./statement-proposal-service";
import { createPreparationCompositionService } from "./preparation-composition-service";
import { createPreparationSnapshotService } from "./snapshot-service";

export const preparationWorkspaceService = createPreparationWorkspaceService({
  repository: preparationWorkspaceRepository,
  storage: tauriPreparationWorkspaceStorage,
});

export const interviewPreparationMaterialExtractionService =
  createPreparationMaterialExtractionService({
    repository: preparationMaterialExtractionRepository,
    gateway: tauriPreparationMaterialExtraction,
    onBackgroundError: (error) => {
      console.warn("[interview-preparation] material extraction failed", error);
    },
    onEvent: (event) => {
      void invoke("write_preparation_trace_log", {
        message: JSON.stringify(event),
      }).catch(() => {});
    },
  });

export const interviewPreparationMaterialService =
  createPreparationMaterialService({
    materials: preparationMaterialRepository,
    materialStorage: tauriPreparationMaterialStorage,
    workspaces: preparationWorkspaceRepository,
    interviewProcesses: interviewProcessRepository,
    extractionScheduler: interviewPreparationMaterialExtractionService,
  });

export const interviewPreparationConversationService =
  createPreparationConversationService({
    repository: preparationConversationRepository,
    interviewProcesses: interviewProcessRepository,
  });

export const interviewPreparationContextComposer =
  createPreparationContextComposer({
    materials: preparationMaterialContextRepository,
    materialInventory: preparationMaterialRepository,
    retrieveKmb: retrieveMemoryContext,
  });

export const interviewPreparationConversationExecutionService =
  createPreparationConversationExecutionService({
    conversations: interviewPreparationConversationService,
    contextComposer: interviewPreparationContextComposer,
    interviewProcesses: interviewProcessRepository,
    materials: preparationMaterialRepository,
    materialExtraction: interviewPreparationMaterialExtractionService,
    imageGateway: tauriPreparationMaterialImage,
    fetchResponse: fetchAIResponse,
    onEvent: (event) => {
      void invoke("write_preparation_trace_log", {
        message: JSON.stringify(event),
      }).catch(() => {});
    },
  });

const writePreparationSemanticTrace = (event: unknown) => {
  void invoke("write_preparation_trace_log", {
    message: JSON.stringify(event),
  }).catch(() => {});
};

export const interviewPreparationStatementProposalService =
  createPreparationStatementProposalService({
    statements: preparationStatementRepository,
    conversations: interviewPreparationConversationService,
    contextComposer: interviewPreparationContextComposer,
    interviewProcesses: interviewProcessRepository,
    fetchResponse: fetchAIResponse,
    onEvent: writePreparationSemanticTrace,
  });

export const interviewPreparationCompositionService =
  createPreparationCompositionService({
    statements: preparationStatementRepository,
    composition: preparationCompositionRepository,
    interviewProcesses: interviewProcessRepository,
    fetchResponse: fetchAIResponse,
    onEvent: writePreparationSemanticTrace,
  });

export const interviewPreparationStatementService =
  createPreparationStatementService({
    repository: preparationStatementRepository,
    interviewProcesses: interviewProcessRepository,
  });

export const interviewPreparationSnapshotService =
  createPreparationSnapshotService({
    statements: preparationStatementRepository,
    composition: preparationCompositionRepository,
    snapshots: preparationSnapshotRepository,
    interviewProcesses: interviewProcessRepository,
    materialExtraction: preparationMaterialExtractionRepository,
    getKmbEntries: getMemoryEntries,
    onEvent: writePreparationSemanticTrace,
  });

export const interviewPreparationService = createInterviewProcessService({
  repository: interviewProcessRepository,
  workspaces: preparationWorkspaceService,
  roundResources: {
    async stageDelete({ processId, roundId }) {
      const lease = await interviewPreparationMaterialService.stageRoundDeletion(
        processId,
        roundId
      );
      const conversationCount =
        await interviewPreparationConversationService.countForRound(
          processId,
          roundId
        );
      return { ...lease, conversationCount };
    },
  },
});
