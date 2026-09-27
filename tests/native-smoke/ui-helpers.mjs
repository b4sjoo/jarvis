// Small wrappers around the existing UI tool, not a second action transport.
export function elementIndex(state, description) {
  const rows = state.split("\n").filter(row => row.trim().match(/^\d+ /));
  const matches = rows.filter(row => {
    let observed = row.trim().replace(/^\d+ /, "");
    // macOS AX replaces an empty field's label with Value + Placeholder after editing.
    const filledField = observed.match(/^(text field \(settable\)) Value:.*?, Placeholder: (.+)$/);
    if (filledField) observed = `${filledField[1]} ${filledField[2]}`;
    return observed.split(/, (?:ID:|Secondary Actions:|Value:)/)[0] === description;
  });
  if (matches.length !== 1) throw new Error(`Expected one visible element: ${description}; found ${matches.length}`);
  return Number(matches[0].trim().match(/^\d+/)[0]);
}

export function assertStatusIdentity(state, buildId) {
  if (state.includes("BUILD ID MISMATCH") || state.includes("Observation unavailable:")) {
    throw new Error("Smoke observer is unavailable or mismatched");
  }
  const lines = state.split("\n").flatMap(row => {
    const match = row.match(/^\s*\d+ text (.*)$/);
    return match ? [match[1]] : [];
  });
  const start = lines.indexOf("{");
  const end = lines.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Smoke status JSON is not accessible");
  const snapshot = JSON.parse(lines.slice(start, end + 1).join("\n"));
  if (snapshot.frontend?.buildId !== buildId || snapshot.native?.buildId !== buildId ||
      snapshot.frontend?.statusViewMounted !== true) {
    throw new Error("Running frontend/native identity or mounted state is missing");
  }
  return snapshot;
}

export function createSmokeChecks({ save = async () => {}, now = () => performance.now() } = {}) {
  const steps = [];
  let stopped = false;
  return {
    steps,
    async step(name, action, { budgetMs = 10000, cleanup = false } = {}) {
      if (stopped && !cleanup) throw new Error("Smoke stopped after a failed step");
      const start = now();
      const result = { name, status: "running", budgetMs };
      steps.push(result);
      try {
        const value = await action();
        // Tool APIs do not offer cancellation. Record overruns; never hide them with retries.
        result.elapsedMs = now() - start;
        if (result.elapsedMs > budgetMs) throw new Error("UI tool exceeded step budget (not cancellable)");
        result.status = "passed";
        return value;
      } catch (error) {
        stopped = true;
        result.elapsedMs = now() - start;
        result.status = "failed";
        result.error = String(error);
        throw error;
      } finally {
        try { await save(steps); }
        catch (error) {
          stopped = true;
          result.status = "failed";
          result.error = `Evidence could not be saved: ${error}`;
          throw error;
        }
      }
    },
  };
}

export async function clickLabel(app, description) {
  const state = await app.getAXState({ disableDiffing: true, emit: false });
  await app.click(elementIndex(state, description));
  return app.getAXState({ disableDiffing: true, emit: false });
}

export async function readStatus(app, buildId) {
  await clickLabel(app, "Jarvis Native Diagnostics Test");
  const state = await clickLabel(app, "Read Smoke Status");
  assertStatusIdentity(state, buildId);
  return state;
}

export async function capture(app, save) {
  const { state, screenshot } = await app.getAXStateAndScreenshot({ disableDiffing: true, emit: false });
  await save({ state, screenshot });
  return state;
}

export async function quit(app) {
  await app.pressKey("super+q");
  // Do not getApp after Quit: the UI tool would launch it again. launch.mjs checks exit.
}
