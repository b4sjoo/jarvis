import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle, Power, RotateCcw } from "lucide-react";
import {
  SHUTDOWN_STAGES, SHUTDOWN_STATUS_EVENT, type ApplicationShutdownReceipt,
} from "../lib/app-shutdown";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./ui/dialog";

const labels = {
  "freezing-new-work": "Stop new work",
  "draining-runtime-and-capture": "Finish runtime and audio",
  "finalizing-recording-and-traces": "Save recording and traces",
};

export function ApplicationShutdownDialog() {
  const [receipt, setReceipt] = useState<ApplicationShutdownReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let receivedEvent = false;
    let unlisten: (() => void) | undefined;
    void listen<ApplicationShutdownReceipt>(SHUTDOWN_STATUS_EVENT, ({ payload }) => {
      receivedEvent = true;
      if (!disposed) setReceipt((previous) => {
        if (previous && (previous.attempt > payload.attempt
          || (previous.attempt === payload.attempt && !previous.waiting && payload.waiting))) return previous;
        return payload;
      });
    }).then(async (cleanup) => {
      if (disposed) { cleanup(); return; }
      unlisten = cleanup;
      const current = await invoke<ApplicationShutdownReceipt | null>("get_app_shutdown");
      if (!disposed && !receivedEvent) setReceipt(current);
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  const act = async (command: "retry_app_shutdown" | "force_app_shutdown") => {
    if (!receipt || busy) return;
    setBusy(true);
    setError(null);
    setConfirmForce(false);
    try {
      const input = { generation: receipt.generation, attempt: receipt.attempt };
      if (command === "retry_app_shutdown") {
        await invoke("retry_app_shutdown", input);
      } else {
        await invoke("force_app_shutdown", input);
      }
    } catch (reason) {
      setError(String(reason));
    } finally { setBusy(false); }
  };

  if (!receipt) return null;
  const unresolved = SHUTDOWN_STAGES.filter((stage) => !receipt.results.some(
    (result) => result.stage === stage && (result.result === "settled" || result.result === "skipped"),
  ));
  return <Dialog open>
    <DialogContent showCloseButton={false} className="rounded-lg"
      onEscapeKeyDown={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}>
      <DialogTitle>{receipt.waiting ? "Quitting Jarvis" : "Quit needs your attention"}</DialogTitle>
      <DialogDescription>
        {receipt.waiting ? "Finishing accepted work and saving session files."
          : "Shutdown is not confirmed. Jarvis remains open; unfinished files may be incomplete."}
      </DialogDescription>
      <ul className="space-y-2 text-sm" aria-live="polite">
        {SHUTDOWN_STAGES.map((stage) => {
          const result = receipt.results.find((item) => item.stage === stage);
          return <li key={stage} className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <span>{labels[stage]}</span>
            <span className="text-muted-foreground">{result?.result ?? "Pending"}</span>
          </li>;
        })}
      </ul>
      {receipt.unresolvedRecordingFolder && <p className="break-all text-sm">
        Recording: {receipt.unresolvedRecordingFolder}
      </p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {confirmForce && <p role="alert" className="text-sm">
        Force Quit will discard unsaved work. {unresolved.map((stage) => labels[stage]).join(", ") || "Exit confirmation"} remains unresolved.
      </p>}
      <DialogFooter>
        {receipt.waiting ? <LoaderCircle className="size-5 animate-spin" aria-label="Finishing shutdown" />
          : confirmForce ? <>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmForce(false)}>Back</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void act("force_app_shutdown")}>
              <Power /> Force Quit Now
            </Button>
          </> : <>
            <Button variant="outline" disabled={busy} onClick={() => void act("retry_app_shutdown")}>
              <RotateCcw /> Retry
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => setConfirmForce(true)}>
              <Power /> Force Quit
            </Button>
          </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
