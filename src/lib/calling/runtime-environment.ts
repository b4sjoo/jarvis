export function isTauriRuntime() {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

export function requireTauriRuntime(action: string) {
  if (!isTauriRuntime()) {
    throw new Error(`${action} is available only in the MOSS desktop app.`);
  }
}
