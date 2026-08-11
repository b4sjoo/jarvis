import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../calling/runtime-environment.js";

export interface SqlDatabase {
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(
    query: string,
    bindValues?: unknown[]
  ): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let desktopDatabase: Promise<SqlDatabase> | undefined;
let writeTail: Promise<void> = Promise.resolve();

const locked = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|code:\s*5\b|SQLITE_BUSY/i.test(message);
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

async function retryLocked<T>(operation: () => Promise<T>) {
  const delays = [40, 100, 250, 500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!locked(error) || attempt >= delays.length) throw error;
      await delay(delays[attempt]);
    }
  }
}

async function withWriteOwnership<T>(operation: () => Promise<T>) {
  const previous = writeTail;
  let release = () => {};
  writeTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

class SerializedPreparationDatabase implements SqlDatabase {
  constructor(private readonly database: SqlDatabase) {}

  select<T>(query: string, bindValues: unknown[] = []) {
    return retryLocked(() => this.database.select<T>(query, bindValues));
  }

  execute(query: string, bindValues: unknown[] = []) {
    return withWriteOwnership(() =>
      retryLocked(() => this.database.execute(query, bindValues))
    );
  }
}

class NativeTransactionDatabase implements SqlDatabase {
  constructor(private readonly transactionId: string) {}

  select<T>(query: string, bindValues: unknown[] = []) {
    return invoke<T>("select_preparation_transaction", {
      transactionId: this.transactionId,
      query,
      values: bindValues,
    });
  }

  execute(query: string, bindValues: unknown[] = []) {
    return invoke<{ rowsAffected: number; lastInsertId?: number }>(
      "execute_preparation_transaction",
      {
        transactionId: this.transactionId,
        query,
        values: bindValues,
      }
    );
  }
}

export function loadPreparationDatabase(): Promise<SqlDatabase> {
  if (!isTauriRuntime()) {
    return Promise.reject(
      new Error("Case Preparation persistence requires the MOSS desktop app.")
    );
  }
  desktopDatabase ??= Database.load("sqlite:moss.db")
    .then((database) => new SerializedPreparationDatabase(database));
  return desktopDatabase;
}

export async function withTransaction<T>(
  database: SqlDatabase,
  operation: (transaction: SqlDatabase) => Promise<T>
) {
  if (isTauriRuntime()) {
    return withWriteOwnership(async () => {
      const transactionId = await retryLocked(() =>
        invoke<string>("begin_preparation_transaction")
      );
      const transaction = new NativeTransactionDatabase(transactionId);
      try {
        const result = await operation(transaction);
        await invoke("commit_preparation_transaction", { transactionId });
        return result;
      } catch (error) {
        await invoke("rollback_preparation_transaction", { transactionId })
          .catch(() => undefined);
        throw error;
      }
    });
  }
  await database.execute("BEGIN IMMEDIATE");
  try {
    const result = await operation(database);
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
