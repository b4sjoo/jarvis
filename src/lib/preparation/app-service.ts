import {
  interviewProcessRepository,
  preparationMaterialRepository,
  preparationWorkspaceRepository,
} from "../database/index";
import { createInterviewProcessService } from "./interview-process-service";
import { tauriPreparationWorkspaceStorage } from "./tauri-storage";
import { tauriPreparationMaterialStorage } from "./material-tauri-storage";
import { createPreparationMaterialService } from "./material-service";
import { createPreparationWorkspaceService } from "./workspace-service";

export const preparationWorkspaceService = createPreparationWorkspaceService({
  repository: preparationWorkspaceRepository,
  storage: tauriPreparationWorkspaceStorage,
});

export const interviewPreparationMaterialService =
  createPreparationMaterialService({
    materials: preparationMaterialRepository,
    materialStorage: tauriPreparationMaterialStorage,
    workspaces: preparationWorkspaceRepository,
    interviewProcesses: interviewProcessRepository,
  });

export const interviewPreparationService = createInterviewProcessService({
  repository: interviewProcessRepository,
  workspaces: preparationWorkspaceService,
  roundResources: {
    stageDelete: ({ processId, roundId }) =>
      interviewPreparationMaterialService.stageRoundDeletion(processId, roundId),
  },
});
