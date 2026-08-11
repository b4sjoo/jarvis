import Database from "@tauri-apps/plugin-sql";
import { isTauriRuntime } from "../calling/runtime-environment.js";

export interface SqlDatabase {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(
    query: string,
    bindValues?: unknown[]
  ): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let desktopDatabase: Promise<SqlDatabase> | undefined;

export function loadPreparationDatabase(): Promise<SqlDatabase> {
  if (!isTauriRuntime()) {
    return Promise.reject(
      new Error("Case Preparation persistence requires the MOSS desktop app.")
    );
  }
  desktopDatabase ??= Database.load("sqlite:moss.db") as Promise<SqlDatabase>;
  return desktopDatabase;
}

export async function withTransaction<T>(
  database: SqlDatabase,
  operation: () => Promise<T>
) {
  await database.execute("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    await database.execute("COMMIT");
    return result;
  } catch (error) {
    await database.execute("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export const encodeJson = (value: unknown) => JSON.stringify(value);

export function decodeJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
