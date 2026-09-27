import AppKit
import ApplicationServices
import Carbon

func require(_ condition: Bool, _ reason: String) throws {
    if !condition { throw NSError(domain: "NativeSmokeKeyboard", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: reason]) }
}

func shortcutKey(_ action: String, _ binding: String) throws -> CGKeyCode {
    switch action {
    case "meeting_focus_mode":
        try require(binding == "cmd+shift+j", "Unsupported Focus binding")
        return CGKeyCode(kVK_ANSI_J)
    case "toggle_dashboard":
        try require(binding == "cmd+shift+d", "Unsupported Dashboard binding")
        return CGKeyCode(kVK_ANSI_D)
    default:
        throw NSError(domain: "NativeSmokeKeyboard", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Unsupported smoke action"])
    }
}

func validateHost(postAccess: Bool, matchingTarget: Bool, soleInstance: Bool) throws {
    try require(postAccess, "Event-post permission unavailable; no permission requested")
    try require(matchingTarget, "Wrong test application/PID")
    try require(soleInstance, "Concurrent or missing Jarvis instance")
}

func keyEvents(_ key: CGKeyCode, restoring flags: CGEventFlags) throws -> (CGEvent, CGEvent) {
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
        throw NSError(domain: "NativeSmokeKeyboard", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Cannot construct paired key events"])
    }
    down.flags = [.maskCommand, .maskShift]
    // Restore the pre-chord state; retaining chord flags on key-up leaves synthetic modifiers held.
    up.flags = flags
    return (down, up)
}

#if NATIVE_SMOKE_POLICY_TESTS
// Compile a separate deterministic executable; this branch cannot post events.
var posts = 0
let negatives: [() throws -> Void] = [
    { _ = try shortcutKey("meeting_screen_context", "cmd+shift+e") },
    { _ = try shortcutKey("meeting_focus_mode", "") },
    { _ = try shortcutKey("meeting_focus_mode", "cmd+shift+d") },
    { _ = try shortcutKey("toggle_dashboard", "cmd+shift+j") },
    { try validateHost(postAccess: false, matchingTarget: true, soleInstance: true) },
    { try validateHost(postAccess: true, matchingTarget: false, soleInstance: true) },
    { try validateHost(postAccess: true, matchingTarget: true, soleInstance: false) },
]
for check in negatives {
    do { try check(); posts += 1 } catch { }
}
precondition(posts == 0)
let focusKey = try shortcutKey("meeting_focus_mode", "cmd+shift+j")
let dashboardKey = try shortcutKey("toggle_dashboard", "cmd+shift+d")
precondition(focusKey == CGKeyCode(kVK_ANSI_J))
precondition(dashboardKey == CGKeyCode(kVK_ANSI_D))
try validateHost(postAccess: true, matchingTarget: true, soleInstance: true)
let (testDown, testUp) = try keyEvents(focusKey, restoring: [])
precondition(testDown.flags == [.maskCommand, .maskShift])
precondition(testUp.flags.isEmpty)
precondition(testDown.type == .keyDown && testUp.type == .keyUp)
print("Keyboard policy: 7 rejected controls, 3 positive controls, paired release verified, 0 posted events")
#else
func report(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    try require(args.count == 4, "Expected PID, exact test bundle path, action and observed binding")
    let key = try shortcutKey(args[2], args[3])
    guard let pid = Int32(args[0]), pid > 0 else {
        throw NSError(domain: "NativeSmokeKeyboard", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Invalid PID"])
    }
    let app = NSRunningApplication(processIdentifier: pid)
    let peers = NSWorkspace.shared.runningApplications.filter { $0.executableURL?.lastPathComponent == "jarvis" }
    try validateHost(
        postAccess: CGPreflightPostEventAccess(),
        matchingTarget: app?.bundleIdentifier == "dev.seasonsg.jarvis.native-diagnostics-test"
            && app?.bundleURL?.standardizedFileURL.path == args[1],
        soleInstance: peers.count == 1 && peers[0].processIdentifier == pid)
    try require(app!.activate(options: []), "Test application activation failed")
    Thread.sleep(forTimeInterval: 0.1)
    try require(NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                "Test application is not frontmost")
    let modifierMask: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate]
    let before = CGEventSource.flagsState(.hidSystemState).intersection(modifierMask)
    try require(before.isEmpty, "Release physical modifier keys before smoke")
    let (down, up) = try keyEvents(key, restoring: before)
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.025)
    up.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.025)
    let after = CGEventSource.flagsState(.hidSystemState).intersection(modifierMask)
    report(["status": "posted-not-yet-observed", "action": args[2], "binding": args[3],
            "pid": pid, "keyDownPosted": true, "keyUpPosted": true,
            "modifierFlagsBefore": before.rawValue, "modifierFlagsAfter": after.rawValue])
} catch {
    report(["status": "blocked", "reason": error.localizedDescription, "keysPosted": 0])
    exit(2)
}
#endif
