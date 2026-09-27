import { capture, elementIndex } from "./ui-helpers.mjs";

// Precondition: the real idle Focus Controls window is visible. Never seed a task.
// This checks editing/clearing a field, not term-correction semantics or pixel layout.
export async function idleCorrectionCase(app, checks, save) {
  const field = "text field (settable) Correction: RAG not rec / Glean";
  await checks.step("idle-correction-edit-clear", async () => {
    const before = await app.getAXState({ disableDiffing: true, emit: false });
    if (!before.includes("Waiting for meeting audio.") || !before.includes("button (disabled) Apply")) {
      throw new Error("Expected the actual idle Controls UI, not a prepared business scenario");
    }
    try {
      await app.setValue(elementIndex(before, field), "RAG not rec");
      const edited = await app.getAXState({ disableDiffing: true, emit: false });
      if (!edited.includes("Value: RAG not rec")) throw new Error("Correction draft was not reflected in the real input");
      await capture(app, save);
    } finally {
      const current = await app.getAXState({ disableDiffing: true, emit: false });
      await app.setValue(elementIndex(current, field), "");
    }
    const cleared = await app.getAXState({ disableDiffing: true, emit: false });
    if (!cleared.includes("button (disabled) Apply") || !cleared.includes("Waiting for meeting audio.")) {
      throw new Error("Idle UI was not restored after clearing the draft");
    }
  });
}
