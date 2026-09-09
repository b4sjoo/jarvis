import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";

/**
 * Database configuration
 */
export const DB_NAME = "sqlite:jarvis.db";

let databaseReady: Promise<Database> | undefined;

/**
 * Get database instance
 */
export function getDatabase(): Promise<Database> {
  if (!databaseReady) {
    databaseReady = (async () => {
      try {
        const database = await Database.load(DB_NAME);
        await invoke("preparation_extraction_initialize");
        return database;
      } catch (error) {
        databaseReady = undefined;
        throw new Error(
          `Failed to initialize database: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();
  }
  return databaseReady;
}
