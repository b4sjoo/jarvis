import type {
  PreparationWorkspace,
  PreparationWorkspaceKind,
  PreparationWorkspaceRepository,
  PreparationWorkspaceStorageGateway,
} from "./types.js";

export interface PreparationWorkspaceServiceDependencies {
  repository: PreparationWorkspaceRepository;
  storage: PreparationWorkspaceStorageGateway;
  now?: () => number;
  createId?: () => string;
}

export interface CreatePreparationWorkspaceInput {
  kind: PreparationWorkspaceKind;
  title: string;
}

export function createPreparationWorkspaceService(
  dependencies: PreparationWorkspaceServiceDependencies
) {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? (() => crypto.randomUUID());

  return {
    async create(
      input: CreatePreparationWorkspaceInput
    ): Promise<PreparationWorkspace> {
      const title = normalizeWorkspaceTitle(input.title);
      const timestamp = now();
      const workspace: PreparationWorkspace = {
        id: createId(),
        kind: input.kind,
        title,
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await dependencies.repository.insert(workspace);
      try {
        await dependencies.storage.ensure({
          kind: workspace.kind,
          workspaceId: workspace.id,
        });
      } catch (error) {
        await dependencies.repository.delete(workspace.id).catch(() => {});
        throw error;
      }
      return workspace;
    },

    list: dependencies.repository.list.bind(dependencies.repository),
    get: dependencies.repository.get.bind(dependencies.repository),

    async archive(id: string): Promise<PreparationWorkspace> {
      const workspace = await requireWorkspace(dependencies.repository, id);
      const timestamp = now();
      await dependencies.repository.setLifecycle({
        id,
        status: "archived",
        updatedAt: timestamp,
        archivedAt: timestamp,
      });
      return { ...workspace, status: "archived", updatedAt: timestamp, archivedAt: timestamp };
    },

    async reopen(id: string): Promise<PreparationWorkspace> {
      const workspace = await requireWorkspace(dependencies.repository, id);
      const timestamp = now();
      await dependencies.repository.setLifecycle({
        id,
        status: "active",
        updatedAt: timestamp,
      });
      return { ...workspace, status: "active", updatedAt: timestamp, archivedAt: undefined };
    },

    async delete(id: string): Promise<void> {
      const workspace = await requireWorkspace(dependencies.repository, id);
      const timestamp = now();
      await dependencies.repository.setLifecycle({
        id,
        status: "deleting",
        updatedAt: timestamp,
        archivedAt: workspace.archivedAt,
      });

      let token: string | undefined;
      try {
        const staged = await dependencies.storage.stageDelete({
          kind: workspace.kind,
          workspaceId: workspace.id,
        });
        token = staged.token;
        await dependencies.repository.delete(id);
      } catch (error) {
        if (token) {
          await dependencies.storage
            .restoreDelete({
              kind: workspace.kind,
              workspaceId: workspace.id,
              token,
            })
            .catch(() => {});
        }
        await dependencies.repository
          .setLifecycle({
            id,
            status: workspace.status,
            updatedAt: now(),
            archivedAt: workspace.archivedAt,
          })
          .catch(() => {});
        throw error;
      }

      if (token) {
        await dependencies.storage.commitDelete({
          kind: workspace.kind,
          token,
        });
      }
    },
  };
}

function normalizeWorkspaceTitle(title: string) {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 160) {
    throw new Error("Preparation workspace title must be 1-160 characters.");
  }
  return normalized;
}

async function requireWorkspace(
  repository: PreparationWorkspaceRepository,
  id: string
) {
  const workspace = await repository.get(id);
  if (!workspace) {
    throw new Error("Preparation workspace not found.");
  }
  return workspace;
}
