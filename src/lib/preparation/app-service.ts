import {
  interviewProcessRepository,
  preparationMaterialExtractionRepository,
  preparationMaterialRepository,
  preparationWorkspaceRepository,
} from "../database/index";
import { createInterviewProcessService } from "./interview-process-service";
import { tauriPreparationWorkspaceStorage } from "./tauri-storage";
import { tauriPreparationMaterialStorage } from "./material-tauri-storage";
import { createPreparationMaterialService } from "./material-service";
import { createPreparationMaterialExtractionService } from "./material-extraction-service";
import { tauriPreparationMaterialExtraction } from "./material-extraction-tauri";
import { createPreparationWorkspaceService } from "./workspace-service";
import { invoke } from "@tauri-apps/api/core";

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

export const interviewPreparationService = createInterviewProcessService({
  repository: interviewProcessRepository,
  workspaces: preparationWorkspaceService,
  roundResources: {
    stageDelete: ({ processId, roundId }) =>
      interviewPreparationMaterialService.stageRoundDeletion(processId, roundId),
  },
});
