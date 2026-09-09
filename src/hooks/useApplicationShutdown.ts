import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ApplicationShutdownCoordinator,
  connectApplicationShutdownOwner,
  type ApplicationShutdownOwner,
} from "../lib/app-shutdown";

/** Mount only alongside useMeetingAssistant; all other WebViews are requesters. */
export function useApplicationShutdown(owner: ApplicationShutdownOwner) {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const coordinator = useRef<ApplicationShutdownCoordinator | null>(null);
  if (!coordinator.current) {
    coordinator.current = new ApplicationShutdownCoordinator({
      freezeNewWork: () => ownerRef.current.freezeNewWork(),
      drainRuntimeAndCapture: () => ownerRef.current.drainRuntimeAndCapture(),
      finalizeRecordingAndTraces: () => ownerRef.current.finalizeRecordingAndTraces(),
      unresolvedRecordingFolder: () => ownerRef.current.unresolvedRecordingFolder(),
    }, { invoke });
  }
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window) || getCurrentWindow().label !== "main") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void connectApplicationShutdownOwner(coordinator.current!, { invoke, listen },
      (error) => console.error("Application shutdown coordination failed", error),
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => console.error("Application shutdown listener failed", error));
    return () => { disposed = true; unlisten?.(); };
  }, []);
}
