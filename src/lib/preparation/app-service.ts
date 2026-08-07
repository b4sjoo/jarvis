import {
  interviewProcessRepository,
  preparationWorkspaceRepository,
} from "../database/index";
import { createInterviewProcessService } from "./interview-process-service";
import { tauriPreparationWorkspaceStorage } from "./tauri-storage";
import { createPreparationWorkspaceService } from "./workspace-service";

export const preparationWorkspaceService = createPreparationWorkspaceService({
  repository: preparationWorkspaceRepository,
  storage: tauriPreparationWorkspaceStorage,
});

export const interviewPreparationService = createInterviewProcessService({
  repository: interviewProcessRepository,
  workspaces: preparationWorkspaceService,
});
