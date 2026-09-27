# Native App Smoke

Opt-in macOS UI checks for a specific native boundary. This is **not** a default
test gate. Pure consumers use deterministic tests; component styles use browser
tests. Do not add native checks merely because this tool exists.

## Build And Launch

```sh
node --test tests/native-smoke/*.test.mjs
node tests/native-smoke/build.mjs
node tests/native-smoke/launch.mjs evidence/native-app-smoke/<build-id>/build.json
```

The build uses a separate frontend/Cargo output, a stable test bundle ID and the
fixed `src-tauri/target/debug/bundle/macos/Jarvis Native Diagnostics Test.app`.
Never launch an old app by name. The launcher requires the latest successful
build manifest and checks its executable hash before starting an owned process.
It waits for UI-driven normal Quit and records process exit and the existing
shutdown receipt. It does not kill ordinary Jarvis or reset application data.
Exit other Jarvis instances first: the real global shortcuts remain unchanged,
so the launcher refuses concurrent instances instead of taking over their keys.

Use the UI tool's `getApp` with the full fixed app path. Open **Read Smoke Status**
in the test application's menu. Both build IDs must match the manifest. The view
samples native window labels/visibility, not business state; target readiness,
busy/error and optional task identities remain evidence from the actual UI.
Refresh by choosing the same menu item again. Sampling adds no history scan,
provider request, or task mutation. Ordinary Debug/Release has no observer.

## UI Scripts

Initial acceptance completed the five base checks on two builds (10 cells), with
explicit physical-shortcut assistance. This validates the bounded capabilities
below, not fully unattended native automation. Retained historical trace panels
are not fresh smoke results; use current idle UI fields and run-owned receipts.

`ui-helpers.mjs` contains small wrappers for the existing UI tool. A script uses
the current accessibility tree to locate controls, invokes real clicks/keys,
and captures state/screenshots. No custom action RPC or business-state setter.

```js
const checks = createSmokeChecks({ save: writeStepResults });
await checks.step("connect", async () => {
  app = await cua.getApp(exactAppPath);
}, { budgetMs: 30000 });
await checks.step("identity", () => readStatus(app, buildId));
// Only actions needed for this change, selected from fresh observed UI state.
await checks.step("quit-request", () => quit(app), { cleanup: true });
// Require launch.mjs's quit-confirmed receipt, not merely this keypress.
```

The five initial infrastructure checks are identity, Meeting/Settings navigation,
Focus entry/exit, repeated Focus plus observation, and normal Quit. They are not
all mandatory for future changes. A small UI target should add only its own
assertion. Never start audio, capture a screen as a meeting input, or call models
as part of this MVP.

`idle-correction-case.mjs` is the narrow example: with the real idle Focus
Controls visible, edit and clear its draft field without pressing Apply. It uses
the same current-AX selectors, step receipt and capture helpers. Its native
execution passed on the unlocked Mac, including restoring the empty draft. The
locator handles AX's Value/Placeholder representation after editing.

### Observed macOS Tool Limits

The current UI tool can click existing buttons, set/read the real input, and
perform menu Quit. In this app, its `pressKey` global Focus shortcut did not reach
the native shortcut handler; physical user shortcuts did. Editor-local Command+A
also did not select the scratch text, while BackSpace and `typeText` worked.
Do not interpret `pressKey` returning as proof of delivery, or assume changing
modifier spelling fixes it. Observe the outcome/available native receipt.

Focus panels expose accessibility text, but their menus can time out even with an
unlocked desktop. A user-selected regular Dashboard permits opening the observer.
Record that assistance explicitly; this is not proven unattended automation.
Protected screenshots may be blank, and the first transition frame may report
zero size before a subsequent state read becomes ready. Do not repeat the business
action to get another screenshot. None of these observations authorizes a second
input transport, new product button or business-control hook.

30s connect/ready and 10s individual UI-operation budgets are test stop limits,
not product SLAs. The UI API may not be cancellable: helpers report elapsed
overruns and stop subsequent actions, rather than claiming preemption. Tool
timeouts, stale targets or inaccessible menus are failures/blocked prerequisites,
not passes. Inspect the exact cause before one bounded retry; do not rebuild or
increase timeouts until the check happens to pass. Protected windows may yield
blank screenshots; accessibility/window evidence does not certify pixel layout.

Keep JSON, screenshots and logs under `evidence/native-app-smoke/<build-id>/`.
Record failures as well as successes. Close only the owned test instance using
normal Quit. Retain manifests/logs and the single current test bundle; do not
delete user databases, grants, credentials, recordings or unrelated processes.
