function render(native) {
  const matches = native?.buildId === __NATIVE_SMOKE_BUILD_ID__;
  document.getElementById("identity-error").textContent = matches ? "" : "BUILD ID MISMATCH";
  const text = JSON.stringify({
    frontend: {
      buildId: __NATIVE_SMOKE_BUILD_ID__, version: __JARVIS_APP_VERSION__,
      commit: __JARVIS_GIT_COMMIT__, dirty: __JARVIS_GIT_DIRTY__,
      builtAt: __JARVIS_BUILD_TIMESTAMP__, statusViewMounted: true,
    },
    native,
  }, null, 2);
  // AX clients truncate a single long text node; keep each bounded line addressable.
  document.getElementById("status").replaceChildren(...text.split("\n").map(line => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    return paragraph;
  }));
}

render(window.__NATIVE_SMOKE_SNAPSHOT__);
// Only the opt-in status window listens, and only the test menu emits a sample.
window.addEventListener("native-smoke-snapshot", ({ detail }) => render(detail));
