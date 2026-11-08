// Minimal, bounded desktop control bridge for workbunny.
// Protocol: one JSON object per stdin line; one {id,ok,...} JSON per stdout line.
import AppKit
import CryptoKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit
import CoreImage
import AVFoundation
import IOSurface
import Vision

struct DesktopError: LocalizedError {
    let message: String
    let code: String?
    let dispatched: Bool?
    let diagnostic: [String: Any]?
    init(message: String, code: String? = nil, dispatched: Bool? = nil, diagnostic: [String: Any]? = nil) {
        self.message = message; self.code = code; self.dispatched = dispatched; self.diagnostic = diagnostic
    }
    var errorDescription: String? { message }
}
struct CaptureUnavailableError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct CaptureBusyError: LocalizedError { var errorDescription: String? { "另一个截图进程正在使用显示连接，稍后继续" } }
var displayOwnerFD: Int32 = -1
func ensureDisplayOwnership(directory: String = NSTemporaryDirectory()) throws {
    if displayOwnerFD >= 0 { return }
    let file = (directory as NSString).appendingPathComponent("workbunny-display-\(getuid()).lock")
    let fd = open(file, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw CaptureBusyError() }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw CaptureBusyError() }
    // WindowServer ownership lasts for this helper's lifetime. Kernel flock
    // releases it even after a crash; a second helper must never initialize a
    // competing CGDisplayStream and block the existing display connection.
    displayOwnerFD = fd
}
let outputLock = NSLock()
let workBuddyTextUTF16Limit = 12_000
func workBuddyTextWithinLimit(_ text: String) -> Bool { text.utf16.count <= workBuddyTextUTF16Limit }
let workBuddyMaxAXDepth = 48
func workBuddyCanDescend(depth: Int, childCount: Int, maxDepth: Int = workBuddyMaxAXDepth) -> Bool {
    childCount > 0 && depth < maxDepth
}
func workBuddyTextControlsAllowed(_ text: String) -> Bool {
    let values = Array(text.unicodeScalars.map(\.value))
    for (index, value) in values.enumerated() {
        if (value < 0x20 && value != 0x0A && value != 0x0D) || value == 0x7F { return false }
        if value == 0x0D && (index + 1 >= values.count || values[index + 1] != 0x0A) { return false }
    }
    return true
}
func writeJSON(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return }
    var line = data; line.append(0x0A)
    outputLock.lock(); FileHandle.standardOutput.write(line); outputLock.unlock()
}
func number(_ value: Any?) -> Double? { (value as? NSNumber)?.doubleValue }
func uint(_ value: Any?) -> UInt32? { (value as? NSNumber)?.uint32Value }
func rectObject(_ rect: CGRect) -> [String: Double] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}
func rectFrom(_ value: Any?) -> CGRect? {
    guard let v = value as? [String: Any], let x = number(v["x"] ?? v["X"]), let y = number(v["y"] ?? v["Y"]),
          let w = number(v["width"] ?? v["Width"]), let h = number(v["height"] ?? v["Height"]), w > 0, h > 0,
          [x, y, w, h].allSatisfy({ $0.isFinite }), w < 100_000, h < 100_000 else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
func windowEntries() -> [[String: Any]] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return raw.compactMap { item in
        guard let id = uint(item[kCGWindowNumber as String]), id != 0,
              let pid = item[kCGWindowOwnerPID as String] as? Int,
              let bounds = item[kCGWindowBounds as String], let rect = rectFrom(bounds),
              let layer = item[kCGWindowLayer as String] as? Int else { return nil }
        // Window titles are intentionally omitted. Bundle identity is process
        // metadata only; it lets background observers associate a window safely.
        let bundleId = NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier ?? ""
        var row: [String: Any] = ["windowId": id, "pid": pid, "bundleId": bundleId, "layer": layer, "rect": rectObject(rect)]
        if let sharing = item[kCGWindowSharingState as String] as? NSNumber { row["sharingState"] = sharing.intValue }
        return row
    }
}
func appIdentity(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app else { return ["pid": 0, "bundleId": "", "name": ""] }
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "launchDate": app.launchDate?.timeIntervalSince1970 ?? 0]
}
func taskProcessIdentity(_ pid: pid_t) -> [String: Any]? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == MemoryLayout<proc_bsdinfo>.size else { return nil }
    var bytes = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &bytes, UInt32(bytes.count)) > 0 else { return nil }
    return ["pid": Int(pid), "pgid": Int(info.pbi_pgid), "uid": Int(info.pbi_uid), "startSeconds": info.pbi_start_tvsec, "startMicros": info.pbi_start_tvusec, "executable": String(cString: bytes)]
}
func taskResourcePause(_ seconds: Double) {
    let until = Date().addingTimeInterval(seconds)
    while Date() < until {
        if !RunLoop.current.run(mode: .default, before: until) { Thread.sleep(forTimeInterval: min(0.01, max(0, until.timeIntervalSinceNow))) }
    }
}
func taskApplicationHealth(_ request: [String: Any]) throws -> [String: Any] {
    guard let bundle = request["bundleId"] as? String, bundle != "com.tencent.xinWeChat" else { throw DesktopError(message: "此应用不允许界面接口诊断") }
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return ["running": false, "reason": "目标软件未运行"] }
    guard AXIsProcessTrusted() else { return ["running": true, "identity": appIdentity(app), "reason": "缺少界面诊断权限，不能据此判为卡死"] }
    let root = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(root, 1)
    var value: CFTypeRef?; let first = AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &value)
    if first == .success { return ["running": true, "responsive": true, "identity": appIdentity(app), "reason": "界面接口已响应"] }
    guard first == .cannotComplete else { return ["running": true, "identity": appIdentity(app), "reason": "界面诊断不可用，未认定卡死"] }
    taskResourcePause(0.25)
    let second = AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &value)
    return ["running": true, "responsive": second != .cannotComplete, "identity": appIdentity(app), "evidence": "two-bounded-interface-probes", "reason": second == .cannotComplete ? "两次有时限的界面请求均未响应" : "第二次界面请求已返回"]
}
func taskApplicationForceStop(_ request: [String: Any]) throws -> [String: Any] {
    try taskResourceDeadline(request)
    guard let identity = request["identity"] as? [String: Any], let pid = identity["pid"] as? Int, let bundle = identity["bundleId"] as? String, let launch = identity["launchDate"] as? Double,
          !["com.tencent.xinWeChat", "cn.haminn.workbunny"].contains(bundle) else { throw DesktopError(message: "缺少可强制恢复的专属应用身份") }
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return ["verified": true, "reason": "原应用已退出，无需强制终止"] }
    guard app.bundleIdentifier == bundle, app.launchDate?.timeIntervalSince1970 == launch else { throw DesktopError(message: "应用身份已变化，未强制终止") }
    let health = try taskApplicationHealth(["bundleId": bundle])
    guard health["responsive"] as? Bool == false else { return ["verified": false, "reason": "当前缺少持续无响应证据，未强制终止"] }
    // Failure to inspect data is uncertainty, never evidence that it is safe to
    // discard. Only a fresh complete list with explicit unedited flags qualifies.
    let root = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(root, 0.5)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(root, kAXWindowsAttribute as CFString, &raw) == .success, let windows = raw as? [AXUIElement] else { return ["verified": false, "reason": "未保存数据状态无法核实，未强制终止"] }
    for window in windows {
        var edited: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, "AXEdited" as CFString, &edited) == .success, let flag = edited as? Bool, flag == false else { return ["verified": false, "reason": "窗口含未保存内容或状态不明，未强制终止"] }
    }
    try taskResourceDeadline(request)
    guard app.forceTerminate() else { return ["verified": false, "reason": "专属应用未能强制终止"] }
    for _ in 0..<20 { if app.isTerminated { return ["verified": true, "reason": "持续无响应、专属身份及无未保存内容已核对，强制终止成功"] }; taskResourcePause(0.1) }
    return ["verified": false, "reason": "强制终止已请求，结束尚未确认"]
}
func taskResourceDeadline(_ request: [String: Any]) throws {
    guard let sent = request["sentAtMs"] as? Double, let timeout = request["timeoutMs"] as? Double, Date().timeIntervalSince1970 * 1000 <= sent + timeout else { throw DesktopError(message: "资源停止请求已过期，未继续操作") }
}
func taskResourceStop(_ request: [String: Any], application: Bool) throws -> [String: Any] {
    try taskResourceDeadline(request)
    guard let identity = request["identity"] as? [String: Any], let pid = identity["pid"] as? Int, pid > 1, pid != getpid(), pid != getppid() else { throw DesktopError(message: "缺少专属进程身份") }
    if application {
        guard let bundle = identity["bundleId"] as? String, !["com.tencent.xinWeChat", "cn.haminn.workbunny"].contains(bundle), let launch = identity["launchDate"] as? Double, launch > 0 else { throw DesktopError(message: "共享应用或启动归属未确认，已保留") }
        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return ["verified": true, "reason": "原应用进程已结束"] }
        guard app.bundleIdentifier == bundle, app.launchDate?.timeIntervalSince1970 == launch else { throw DesktopError(message: "应用进程身份已变化，未退出其它应用") }
        try taskResourceDeadline(request)
        guard app.terminate() else { return ["verified": false, "reason": "专属应用未接受退出请求，可能有未保存内容；已保留"] }
        for _ in 0..<20 { if app.isTerminated { return ["verified": true, "reason": "任务专属应用已退出"] }; taskResourcePause(0.1) }
        return ["verified": false, "reason": "已请求正常退出，尚未确认；未强制关闭未保存内容"]
    }
    guard let actual = taskProcessIdentity(pid_t(pid)) else {
        return kill(-pid_t(pid), 0) == -1 && errno == ESRCH ? ["verified": true, "reason": "原进程组已结束"] : ["verified": false, "reason": "原进程已消失但组内进程仍存在，无法重新核实归属，已保留"]
    }
    for field in ["pid", "pgid", "uid", "startSeconds", "startMicros", "executable"] {
        guard let expected = identity[field] as? NSObject, let observed = actual[field] as? NSObject, expected == observed else { throw DesktopError(message: "进程身份已变化，未停止其它进程") }
    }
    guard actual["pgid"] as? Int == pid, actual["uid"] as? Int == Int(getuid()) else { throw DesktopError(message: "不是本任务可独立停止的用户进程组") }
    try taskResourceDeadline(request)
    _ = kill(-pid_t(pid), SIGTERM)
    for i in 0..<20 {
        if kill(-pid_t(pid), 0) == -1 && errno == ESRCH { return ["verified": true, "reason": "任务命令进程组已结束"] }
        if i == 7, let fresh = taskProcessIdentity(pid_t(pid)), (fresh["startSeconds"] as? NSNumber) == (identity["startSeconds"] as? NSNumber), (fresh["startMicros"] as? NSNumber) == (identity["startMicros"] as? NSNumber) { try taskResourceDeadline(request); _ = kill(-pid_t(pid), SIGKILL) }
        taskResourcePause(0.1)
    }
    return ["verified": false, "reason": "已请求停止命令，但进程组结束尚未确认"]
}
func sessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}
func currentFrontmost() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }
func checkExpected(_ request: [String: Any]) throws {
    guard let expected = request["expected"] as? [String: Any],
          let bundle = expected["bundleId"] as? String, !bundle.isEmpty,
          let pid = expected["pid"] as? Int else { throw DesktopError(message: "动作需要 expected.bundleId 和 expected.pid") }
    guard let actual = currentFrontmost(), actual.bundleIdentifier == bundle,
          Int(actual.processIdentifier) == pid else { throw DesktopError(message: "前台窗口已变化，请重新获取前台信息") }
}
func targetWindow(_ request: [String: Any]) throws -> (UInt32, CGRect) {
    guard let id = uint(request["windowId"]), id != 0,
          let row = windowEntries().first(where: { ($0["windowId"] as? UInt32) == id }),
          let rect = rectFrom(row["rect"]) else { throw DesktopError(message: "目标窗口已关闭或不可见") }
    guard let expected = request["expected"] as? [String: Any], let pid = expected["pid"] as? Int,
          (row["pid"] as? Int) == pid else { throw DesktopError(message: "目标窗口不属于预期前台进程") }
    return (id, rect)
}
func point(_ request: [String: Any], in rect: CGRect) throws -> CGPoint {
    guard let x = number(request["x"]), let y = number(request["y"]), x.isFinite, y.isFinite,
          x >= rect.minX, x < rect.maxX, y >= rect.minY, y < rect.maxY else {
        throw DesktopError(message: "坐标超出目标窗口范围")
    }
    return CGPoint(x: x, y: y)
}
func postMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw DesktopError(message: "无法创建鼠标事件")
    }
    event.post(tap: .cghidEventTap)
}
func postUnicodeText(_ units: [UInt16], targetPID: pid_t? = nil) throws {
    guard !units.isEmpty else { return }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw DesktopError(message: "无法创建文本事件") }
        event.flags = []
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        if let targetPID { event.postToPid(targetPID) } else { event.post(tap: .cghidEventTap) }
    }
}
func postShiftReturn(targetPID: pid_t? = nil) throws {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down) else { throw DesktopError(message: "无法创建软换行事件") }
        event.flags = .maskShift
        if let targetPID { event.postToPid(targetPID) } else { event.post(tap: .cghidEventTap) }
    }
}
func keyCode(_ name: String) -> CGKeyCode? {
    let table: [String: UInt16] = [
        // ANSI physical key positions; letters use the standard US ANSI layout.
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "7": 26, "8": 28, "9": 25, "0": 29,
        "'": 39,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "forwarddelete": 117,
        "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    let alpha: [String: UInt16] = ["a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34,
        "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15,
        "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6]
    var all = table; all.merge(alpha) { current, _ in current }
    return all[name.lowercased()].map { CGKeyCode($0) }
}
func modifiers(_ value: Any?) throws -> CGEventFlags {
    guard let names = value as? [String] else { return [] }
    var flags: CGEventFlags = []
    for name in names {
        switch name.lowercased() {
        case "shift": flags.insert(.maskShift)
        case "control", "ctrl": flags.insert(.maskControl)
        case "option", "alt": flags.insert(.maskAlternate)
        case "command", "cmd": flags.insert(.maskCommand)
        default: throw DesktopError(message: "不支持的修饰键：\(name)")
        }
    }
    return flags
}
func validateActionContext(_ request: [String: Any]) throws -> (UInt32, CGRect) {
    guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
    let deadline = number(request["timeoutMs"]) ?? 3000
    guard let began = number(request["sentAtMs"]), deadline.isFinite, deadline >= 1, deadline <= 10_000,
          Date().timeIntervalSince1970 * 1000 - began <= deadline else { throw DesktopError(message: "动作请求已超时") }
    try checkExpected(request)
    return try targetWindow(request)
}

let workBuddyBundleID = "com.tencent.workbuddy.mac"
let workBuddyUIModel = "DeepSeek-V4.1-Flash"
func workBuddyModelLabelAllowed(_ value: String?) -> Bool { value?.lowercased() == workBuddyUIModel.lowercased() }
let workBuddyRTEEmptyValue = "\u{FEFF}\n今天帮你做些什么？@ 添加上下文，/调用技能与指令"
enum WorkBuddyDraftPlan { case write, alreadyFilled, reject }
func workBuddyBundleAllowed(_ bundle: String?) -> Bool { bundle == workBuddyBundleID }
func workBuddyMarkerAllowed(_ marker: String?) -> Bool {
    guard let marker, marker.hasPrefix("[workbunny:"), marker.hasSuffix("]") else { return false }
    let value = String(marker.dropFirst("[workbunny:".count).dropLast())
    return UUID(uuidString: value) != nil && marker.utf16.count <= 64
}
func workBuddyModelAllowed(_ requestModel: String?, selectedModel: String?) -> Bool {
    requestModel == "deepseek-v4.1-flash" && workBuddyModelLabelAllowed(selectedModel)
}
func workBuddyDraftIsEmpty(_ raw: String?, sendButtonCount: Int = 0, sendEnabled: Bool = true) -> Bool {
    raw == "" || raw == "\u{FEFF}" ||
        (raw == workBuddyRTEEmptyValue && sendButtonCount == 1 && !sendEnabled)
}
func workBuddyTextMatches(_ raw: String?, expected: String) -> Bool {
    guard let raw else { return false }
    if raw == expected { return true }
    var comparable = raw
    if !expected.hasPrefix("\u{FEFF}") && comparable.hasPrefix("\u{FEFF}") { comparable.removeFirst() }
    // The RTE serializes a soft break as FEFF + LF + FEFF after real
    // keyboard/paste input. Remove only this observed boundary pair.
    if !expected.contains("\u{FEFF}") { comparable = comparable.replacingOccurrences(of: "\u{FEFF}\n\u{FEFF}", with: "\n") }
    if comparable == expected { return true }
    let actualLines = comparable.components(separatedBy: "\n")
    let expectedLines = expected.components(separatedBy: "\n")
    guard actualLines.count == expectedLines.count else { return false }
    for (actualLine, expectedLine) in zip(actualLines, expectedLines) {
        if actualLine == expectedLine { continue }
        if expectedLine.isEmpty && actualLine == "\u{FEFF}" { continue }
        return false
    }
    return true
}
func workBuddyDraftPlan(current: String?, requested: String, sendButtonCount: Int = 0, sendEnabled: Bool = true) -> WorkBuddyDraftPlan {
    guard current != nil else { return .reject }
    if workBuddyDraftIsEmpty(current, sendButtonCount: sendButtonCount, sendEnabled: sendEnabled) { return .write }
    if workBuddyTextMatches(current, expected: requested) { return .alreadyFilled }
    return .reject
}
struct WorkBuddySubmissionExpectation { let text: String; let mode: String; let marker: String? }
func workBuddySubmissionExpectation(_ request: [String: Any]) throws -> WorkBuddySubmissionExpectation? {
    let fields = ["expectedSubmissionText", "expectedSubmissionMode", "expectedSubmissionMarker"]
    guard fields.contains(where: { request[$0] != nil }) else { return nil }
    guard let expected = request["expected"] as? [String: Any],
          workBuddyBundleAllowed(expected["bundleId"] as? String),
          let op = request["op"] as? String, ["click", "key"].contains(op),
          let text = request["expectedSubmissionText"] as? String, !text.isEmpty,
          workBuddyTextWithinLimit(text), workBuddyTextControlsAllowed(text),
          let mode = request["expectedSubmissionMode"] as? String, ["home", "conversation"].contains(mode),
          request["expectedSubmissionMarker"] == nil || workBuddyMarkerAllowed(request["expectedSubmissionMarker"] as? String),
          mode != "conversation" || workBuddyMarkerAllowed(request["expectedSubmissionMarker"] as? String) else {
        throw DesktopError(message: "提交草稿核对参数无效或目标不是 WorkBuddy，未派发输入", code: "E_GUI_DRAFT_UNVERIFIED", dispatched: false)
    }
    return WorkBuddySubmissionExpectation(text: text, mode: mode, marker: request["expectedSubmissionMarker"] as? String)
}
enum WorkBuddySubmissionDraftState { case ready, conflict, unverified }
func workBuddySubmissionDraftState(scanComplete: Bool, editorCount: Int, targetReady: Bool,
                                   scannedDraft: String?, currentDraft: String?, expected: String) -> WorkBuddySubmissionDraftState {
    guard scanComplete, editorCount == 1, targetReady, let scannedDraft, let currentDraft else { return .unverified }
    guard workBuddyTextMatches(scannedDraft, expected: expected), workBuddyTextMatches(currentDraft, expected: expected) else { return .conflict }
    return .ready
}
struct WorkBuddySendGuardPlan {
    let checks: [String: Bool]
    let conflictingDraft: Bool
    var ready: Bool { checks.values.allSatisfy { $0 } }
}
func workBuddySendGuardPlan(scanComplete: Bool, childrenFetchErrors: Int, editorCount: Int,
                            targetReady: Bool, modelMatched: Bool, draft: String?, requested: String,
                            sendButtonCount: Int, sendEnabled: Bool) -> WorkBuddySendGuardPlan {
    let draftMatched = workBuddyTextMatches(draft, expected: requested)
    return WorkBuddySendGuardPlan(checks: [
        "scanComplete": scanComplete, "childrenReadable": childrenFetchErrors == 0,
        "editorUnique": editorCount == 1, "targetReady": targetReady,
        "modelMatched": modelMatched, "draftMatched": draftMatched,
        "sendButtonUnique": sendButtonCount == 1, "sendEnabled": sendEnabled
    ], conflictingDraft: editorCount == 1 && draft != nil && !draftMatched &&
        !workBuddyDraftIsEmpty(draft, sendButtonCount: sendButtonCount, sendEnabled: sendEnabled))
}
func workBuddySendGuardDiagnostic(_ plan: WorkBuddySendGuardPlan, background: Bool, sendButtonCount: Int) -> [String: Any] {
    ["operation": "submit", "method": background ? "background-ax" : "foreground-ax",
     "candidateCount": sendButtonCount, "guardChecks": plan.checks]
}
func workBuddyControlsUnique(editors: Int, combos: Int, sendButtons: Int, scanComplete: Bool) -> Bool {
    scanComplete && editors == 1 && combos == 1 && sendButtons == 1
}
func workBuddyHomeReady(title: String?) -> Bool {
    guard let title else { return false }
    let canonical = title.replacingOccurrences(of: "，", with: ",")
        .unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }
    return String(String.UnicodeScalarView(canonical)) == "WorkBuddy,我帮你"
}
func workBuddyHeadingHomeReady(value: String?, title: String?, description: String?) -> Bool {
    [value, title, description].compactMap { $0 }.contains(where: workBuddyHomeReady)
}
func workBuddyTargetReady(mode: String, homeReady: Bool, conversationMarkerPresent: Bool) -> Bool {
    mode == "home" ? homeReady : (mode == "conversation" && conversationMarkerPresent)
}

struct WorkBuddyContext { let pid: pid_t; let windowID: UInt32; let rect: CGRect }
struct WorkBuddyControls {
    let application: AXUIElement?
    let editors: [AXUIElement]
    let editorFocusElements: [AXUIElement]
    let combos: [(AXUIElement, String?)]
    let sendButtons: [(AXUIElement, Bool)]
    let draft: String?
    let selectedModel: String?
    let sendEnabled: Bool
    let homeReady: Bool
    let associationMarkerPresent: Bool
    let scanComplete: Bool
    let visitedNodes: Int
    let maxDepthVisited: Int
    let depthCutoff: Bool
    let markerTextFound: Bool
    let markerFrameMissing: Bool
    let markerFrameOutsideTarget: Bool
    let childrenFetchErrors: Int
}
func validateWorkBuddyContext(_ request: [String: Any], requireFrontmost: Bool = true) throws -> WorkBuddyContext {
    guard let expected = request["expected"] as? [String: Any],
          let bundle = expected["bundleId"] as? String, workBuddyBundleAllowed(bundle),
          let pidValue = expected["pid"] as? Int, pidValue > 0 else {
        throw DesktopError(message: "WorkBuddy AX 操作仅允许目标应用 com.tencent.workbuddy.mac")
    }
    guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
    guard let app=NSRunningApplication(processIdentifier:pid_t(pidValue)),workBuddyBundleAllowed(app.bundleIdentifier) else { throw DesktopError(message:"WorkBuddy 进程身份已变化") }
    if requireFrontmost {
        guard let front = currentFrontmost(), workBuddyBundleAllowed(front.bundleIdentifier),
              Int(front.processIdentifier) == pidValue else { throw DesktopError(message: "当前前台不是预期 WorkBuddy 窗口") }
    }
    let deadline=number(request["timeoutMs"]) ?? 3000
    guard let began=number(request["sentAtMs"]),deadline>=1,deadline<=10000,Date().timeIntervalSince1970*1000-began<=deadline else { throw DesktopError(message:"动作请求已超时") }
    let (windowID, rect) = try targetWindow(request)
    return WorkBuddyContext(pid: pid_t(pidValue), windowID: windowID, rect: rect)
}
func revalidateWorkBuddyContext(_ request: [String: Any], _ original: WorkBuddyContext, requireFrontmost: Bool = true) throws {
    let current = try validateWorkBuddyContext(request,requireFrontmost:requireFrontmost)
    guard current.pid == original.pid, current.windowID == original.windowID,
          abs(current.rect.minX - original.rect.minX) <= 1,
          abs(current.rect.minY - original.rect.minY) <= 1,
          abs(current.rect.width - original.rect.width) <= 1,
          abs(current.rect.height - original.rect.height) <= 1 else {
        throw DesktopError(message: "WorkBuddy 前台窗口或几何已变化")
    }
}
func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func axValueAttribute(_ element: AXUIElement, _ name: String) -> AXValue? {
    guard let value = axAttribute(element, name) else { return nil }
    return unsafeBitCast(value, to: AXValue.self)
}
func axElementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = axAttribute(element, name) else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
func axWindowRect(_ window: AXUIElement) -> CGRect? {
    guard let position = axValueAttribute(window, kAXPositionAttribute as String),
          let size = axValueAttribute(window, kAXSizeAttribute as String) else { return nil }
    var origin = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(size, .cgSize, &dimensions),
          origin.x.isFinite, origin.y.isFinite, dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: origin, size: dimensions)
}
func rectsMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX-rhs.minX) <= 2 && abs(lhs.minY-rhs.minY) <= 2 &&
    abs(lhs.width-rhs.width) <= 2 && abs(lhs.height-rhs.height) <= 2
}
func rectIntersects(_ lhs: CGRect?, _ rhs: CGRect) -> Bool {
    guard let lhs, lhs.minX.isFinite, lhs.minY.isFinite, lhs.width > 0, lhs.height > 0,
          rhs.width > 0, rhs.height > 0 else { return false }
    let intersection = lhs.intersection(rhs)
    return !intersection.isNull && intersection.width > 0 && intersection.height > 0
}
func workBuddyAXWindow(app: AXUIElement, targetRect: CGRect) -> AXUIElement? {
    let focused = axElementAttribute(app, kAXFocusedWindowAttribute as String)
    let main = axElementAttribute(app, kAXMainWindowAttribute as String)
    for candidate in [focused, main].compactMap({ $0 }) {
        AXUIElementSetMessagingTimeout(candidate, 0.2)
        if let rect = axWindowRect(candidate), rectsMatch(rect, targetRect) { return candidate }
    }
    return nil
}
func scanWorkBuddyControls(_ root: AXUIElement, deadline: UInt64, associationMarker: String?, targetRect: CGRect) -> WorkBuddyControls {
    var editors: [AXUIElement] = []
    var editorFocusElements: [AXUIElement] = []
    var combos: [(AXUIElement, String?)] = []
    var sends: [(AXUIElement, Bool)] = []
    var queue: [(AXUIElement, Int, Bool)] = [(root, 0, false)]
    var cursor = 0, visited = 0, complete = true
    var maxDepthVisited = 0, depthCutoff = false, markerTextFound = false
    var markerFrameMissing = false, markerFrameOutsideTarget = false, childrenFetchErrors = 0
    var draft: String?, selected: String?, homeHeadingFound = false, associationMarkerPresent = false
    while cursor < queue.count {
        if DispatchTime.now().uptimeNanoseconds > deadline || visited >= 2000 { complete = false; break }
        let (element, depth, insideEditor) = queue[cursor]; cursor += 1; visited += 1
        maxDepthVisited = max(maxDepthVisited, depth)
        AXUIElementSetMessagingTimeout(element, 0.2)
        guard let role = axAttribute(element, kAXRoleAttribute as String) as? String else { continue }
        let isEditor = role == kAXTextAreaRole as String
        if insideEditor || isEditor { editorFocusElements.append(element) }
        if !insideEditor && !isEditor, let associationMarker {
            for attribute in [kAXValueAttribute as String, kAXTitleAttribute as String, kAXDescriptionAttribute as String] {
                if (axAttribute(element, attribute) as? String)?.contains(associationMarker) == true {
                    markerTextFound = true
                    let frame = axWindowRect(element)
                    if frame == nil { markerFrameMissing = true }
                    else if rectIntersects(frame, targetRect) {
                        associationMarkerPresent = true
                    } else { markerFrameOutsideTarget = true }
                }
            }
        }
        if isEditor {
            editors.append(element)
            if let value = axAttribute(element, kAXValueAttribute as String) as? String { draft = value }
        } else if role == kAXHeadingRole as String {
            let value = axAttribute(element, kAXValueAttribute as String) as? String
            let title = axAttribute(element, kAXTitleAttribute as String) as? String
            let description = axAttribute(element, kAXDescriptionAttribute as String) as? String
            if workBuddyHeadingHomeReady(value: value, title: title, description: description) { homeHeadingFound = true }
        } else if role == kAXComboBoxRole as String,
                  let description = axAttribute(element, kAXDescriptionAttribute as String) as? String,
                  description.hasPrefix("Select model:") {
            let value = axAttribute(element, kAXValueAttribute as String) as? String
            combos.append((element, value)); selected = value
        } else if role == kAXButtonRole as String {
            let title = axAttribute(element, kAXTitleAttribute as String) as? String
            let description = title == "发送" ? nil : axAttribute(element, kAXDescriptionAttribute as String) as? String
            if title == "发送" || description == "发送" {
                let enabled = (axAttribute(element, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? false
                sends.append((element, enabled))
            }
        }
        var childrenValue: CFTypeRef?
        let childrenStatus = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
        if childrenStatus == .success, let children = childrenValue as? [AXUIElement] {
            if !children.isEmpty && !workBuddyCanDescend(depth: depth, childCount: children.count) {
                complete = false; depthCutoff = true; break
            } else if !children.isEmpty {
                queue.append(contentsOf: children.map { ($0, depth + 1, insideEditor || isEditor) })
            }
        } else if childrenStatus != .attributeUnsupported && childrenStatus != .noValue {
            childrenFetchErrors += 1
        }
    }
    return WorkBuddyControls(application: nil, editors: editors, editorFocusElements: editorFocusElements, combos: combos, sendButtons: sends, draft: draft,
        selectedModel: selected, sendEnabled: sends.count == 1 && sends[0].1,
        homeReady: homeHeadingFound, associationMarkerPresent: associationMarkerPresent, scanComplete: complete,
        visitedNodes: visited, maxDepthVisited: maxDepthVisited, depthCutoff: depthCutoff,
        markerTextFound: markerTextFound, markerFrameMissing: markerFrameMissing,
        markerFrameOutsideTarget: markerFrameOutsideTarget, childrenFetchErrors: childrenFetchErrors)
}
func workBuddyControls(_ request: [String: Any]) throws -> (WorkBuddyContext, WorkBuddyControls, Bool) {
    let mode = request["mode"] as? String ?? "home"
    let marker = request["marker"] as? String
    guard mode == "home" || (mode == "conversation" && workBuddyMarkerAllowed(marker)) else {
        throw DesktopError(message: "WorkBuddy AX 模式或会话关联标记无效")
    }
    guard mode == "home" || marker != nil else { throw DesktopError(message: "conversation 模式必须提供本任务关联标记") }
    let background = request["background"] as? Bool == true
    let context = try validateWorkBuddyContext(request, requireFrontmost: !background)
    guard AXIsProcessTrusted() else { throw DesktopError(message: "缺少辅助功能权限") }
    // The exact bundle/PID and matching visible CG window are checked before creating any AX element.
    let app = AXUIElementCreateApplication(context.pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let window = workBuddyAXWindow(app: app, targetRect: context.rect) else {
        try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
        return (context, WorkBuddyControls(application: app, editors: [], editorFocusElements: [], combos: [], sendButtons: [], draft: nil,
            selectedModel: nil, sendEnabled: false, homeReady: false, associationMarkerPresent: false, scanComplete: false,
            visitedNodes: 0, maxDepthVisited: 0, depthCutoff: false, markerTextFound: false,
            markerFrameMissing: false, markerFrameOutsideTarget: false, childrenFetchErrors: 0), false)
    }
    let title = axAttribute(window, kAXTitleAttribute as String) as? String
    let scanned = scanWorkBuddyControls(window, deadline: DispatchTime.now().uptimeNanoseconds + 2_000_000_000,
                                        associationMarker: marker, targetRect: context.rect)
    let controls = WorkBuddyControls(application: app, editors: scanned.editors, editorFocusElements: scanned.editorFocusElements,
        combos: scanned.combos, sendButtons: scanned.sendButtons,
        draft: scanned.draft, selectedModel: scanned.selectedModel, sendEnabled: scanned.sendEnabled,
        homeReady: workBuddyHomeReady(title: title) || scanned.homeReady, associationMarkerPresent: scanned.associationMarkerPresent, scanComplete: scanned.scanComplete,
        visitedNodes: scanned.visitedNodes, maxDepthVisited: scanned.maxDepthVisited, depthCutoff: scanned.depthCutoff,
        markerTextFound: scanned.markerTextFound, markerFrameMissing: scanned.markerFrameMissing,
        markerFrameOutsideTarget: scanned.markerFrameOutsideTarget, childrenFetchErrors: scanned.childrenFetchErrors)
    try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
    let available = workBuddyControlsUnique(editors: controls.editors.count, combos: controls.combos.count,
                                             sendButtons: controls.sendButtons.count, scanComplete: controls.scanComplete)
    return (context, controls, available)
}
// The caller supplies host-owned expected text only for a raw WorkBuddy submit.
// This observation is kept in the same native dispatch as the first event; it
// neither chooses a submit method nor replaces the existing action guards.
func validateWorkBuddySubmission(_ request: [String: Any], _ expectation: WorkBuddySubmissionExpectation?) throws {
    guard let expectation else { return }
    do {
        var scoped = request
        scoped["mode"] = expectation.mode; scoped["marker"] = expectation.marker
        scoped["background"] = false
        let (context, controls, _) = try workBuddyControls(scoped)
        try revalidateWorkBuddyContext(scoped, context)
        if request["op"] as? String == "key", !workBuddyEditorFocused(controls) {
            throw DesktopError(message: "提交前未能核实本任务编辑器焦点，未发送按键", code: "E_GUI_DRAFT_UNVERIFIED", dispatched: false)
        }
        let currentDraft = controls.editors.first.flatMap { axAttribute($0, kAXValueAttribute as String) as? String }
        switch workBuddySubmissionDraftState(scanComplete: controls.scanComplete && controls.childrenFetchErrors == 0, editorCount: controls.editors.count,
            targetReady: workBuddyTargetReady(mode: expectation.mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent),
            scannedDraft: controls.draft, currentDraft: currentDraft, expected: expectation.text) {
        case .conflict:
            throw DesktopError(message: "提交前草稿与本任务全文不一致，已保留原内容且未提交", code: "E_WORKBUDDY_DRAFT_CONFLICT", dispatched: false)
        case .unverified:
            throw DesktopError(message: "提交前编辑器、目标页面或草稿无法完整核对，未提交", code: "E_GUI_DRAFT_UNVERIFIED", dispatched: false)
        case .ready: break
        }
        try revalidateWorkBuddyContext(scoped, context)
        _ = try validateActionContext(request)
    } catch let error as DesktopError {
        throw DesktopError(message: error.message, code: error.code ?? "E_GUI_DRAFT_UNVERIFIED", dispatched: false)
    } catch {
        throw DesktopError(message: "提交前草稿核对未取得有效读回，未提交", code: "E_GUI_DRAFT_UNVERIFIED", dispatched: false)
    }
}
// WorkBuddy-only semantic navigation. No generic AX endpoint is exported.
struct WorkBuddyNavigationNode {
    let element: AXUIElement
    let role: String
    let label: String
    let inMenu: Bool
}
// The workspace popup belongs to the composer's lower left edge. Window
// percentages describe neither that relationship nor a collapsed sidebar.
func workBuddyWorkspacePickerRect(_ popup: CGRect, editor: CGRect, window: CGRect) -> Bool {
    guard window.contains(popup), window.contains(editor), popup.width > 0, popup.height > 0,
          editor.width > 0, editor.height > 0 else { return false }
    return abs(popup.minX - editor.minX) <= 48 && popup.midX <= editor.maxX &&
        popup.minY >= editor.maxY - 8 && popup.maxY <= editor.maxY + 120
}
func workBuddyNavigation(_ request: [String: Any]) throws -> [String: Any] {
    let background = request["background"] as? Bool == true
    let operation = request["operation"] as? String ?? "inspect"
    func locateError(_ message: String, count: Int? = nil) -> DesktopError {
        var diagnostic: [String: Any] = ["operation": operation, "method": background ? "background-ax" : "foreground-ax"]
        if let count { diagnostic["candidateCount"] = count }
        return DesktopError(message: message, code: count.map { $0 > 1 ? "E_GUI_LOCATE_AMBIGUOUS" : "E_GUI_LOCATE_MISSING" } ?? "E_GUI_LOCATE_UNAVAILABLE", dispatched: false, diagnostic: diagnostic)
    }
    let context = try validateWorkBuddyContext(request, requireFrontmost: !background)
    guard AXIsProcessTrusted() else { throw DesktopError(message: "缺少辅助功能权限") }
    let app = AXUIElementCreateApplication(context.pid)
    guard let window = workBuddyAXWindow(app: app, targetRect: context.rect) else { throw locateError("WorkBuddy 目标窗口的辅助功能结构不可用") }
    var queue: [(AXUIElement, Int, Bool)] = [(window, 0, false)], nodes: [WorkBuddyNavigationNode] = []
    var cursor = 0, editorRects: [CGRect] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    while cursor < queue.count {
        guard cursor < 2500, DispatchTime.now().uptimeNanoseconds < deadline else { throw locateError("WorkBuddy 导航结构尚未完整读取") }
        let (element, depth, parentMenu) = queue[cursor]; cursor += 1
        AXUIElementSetMessagingTimeout(element, 0.15)
        guard let role = axAttribute(element, kAXRoleAttribute as String) as? String else { continue }
        if role == kAXTextAreaRole as String {
            if let rect = axWindowRect(element), context.rect.contains(rect) { editorRects.append(rect) }
            continue
        }
        let inMenu = parentMenu || role == kAXMenuRole as String
        var label = (axAttribute(element, kAXTitleAttribute as String) as? String) ?? ""
        if label.isEmpty { label = (axAttribute(element, kAXDescriptionAttribute as String) as? String) ?? "" }
        if label.isEmpty && (role == kAXStaticTextRole as String || role == kAXHeadingRole as String) { label = (axAttribute(element, kAXValueAttribute as String) as? String) ?? "" }
        if !label.isEmpty && label.utf16.count < 200 { nodes.append(WorkBuddyNavigationNode(element: element, role: role, label: label, inMenu: inMenu)) }
        if let children = axAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement], !children.isEmpty {
            guard depth < 48 else { throw locateError("WorkBuddy 导航结构尚未完整读取") }
            queue.append(contentsOf: children.map { ($0, depth+1, inMenu) })
        }
    }
    let popups = nodes.filter { !$0.inMenu && $0.role == kAXPopUpButtonRole as String }
    let pickers = nodes.filter { node in
        guard !node.inMenu, node.role == kAXPopUpButtonRole as String, editorRects.count == 1,
              let rect = axWindowRect(node.element) else { return false }
        return workBuddyWorkspacePickerRect(rect, editor: editorRects[0], window: context.rect)
    }
    let picker = pickers.count == 1 ? pickers[0] : nil
    let menuItems = nodes.filter { $0.inMenu && $0.role == kAXMenuItemRole as String }
    let conversationNodes = nodes.filter { node in
        guard let rect = axWindowRect(node.element), node.role == kAXStaticTextRole as String else { return false }
        return rect.midX < context.rect.minX + context.rect.width * 0.32 && rect.midY > context.rect.minY + 160
    }
    let buddyExits = nodes.filter { $0.label == "退出当前 Buddy 应用" && $0.role == kAXButtonRole as String }
    if operation == "inspect" {
        return ["workspace": picker?.label ?? "", "pickerAvailable": picker != nil,
                "workspacePicker": ["editorCount": editorRects.count, "popupCount": popups.count, "candidateCount": pickers.count],
                "menuOpen": !menuItems.isEmpty, "workspaces": menuItems.map { $0.label }.filter { !["新建工作空间", "打开本地文件夹", "不使用工作空间"].contains($0) },
                "homeReady": nodes.contains { workBuddyHomeReady(title: $0.label) }, "buddyAppActive": !buddyExits.isEmpty,
                "conversations": conversationNodes.map { $0.label }]
    }
    var candidates: [WorkBuddyNavigationNode] = []
    if operation == "newTask" { candidates = nodes.filter { $0.label == "新建任务" && $0.role != kAXStaticTextRole as String } }
    else if operation == "exitBuddyApp" { candidates = buddyExits }
    else if operation == "selectConversation", let name = request["name"] as? String, !name.isEmpty, name.utf16.count <= 199 { candidates = conversationNodes.filter { $0.label == name } }
    else if operation == "workspaceMenu" { candidates = pickers }
    else if operation == "selectWorkspace", let name = request["name"] as? String, !name.isEmpty, name.utf16.count <= 160 { candidates = menuItems.filter { $0.label == name } }
    else { throw DesktopError(message: "WorkBuddy 导航动作不支持或控件不可用") }
    guard candidates.count == 1 else { throw locateError(candidates.isEmpty ? "WorkBuddy 导航控件未找到" : "WorkBuddy 导航控件有多个候选", count: candidates.count) }
    let chosen = candidates[0]
    try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
    let pressed = AXUIElementPerformAction(chosen.element, kAXPressAction as CFString)
    if pressed != .success {
        if background {
            throw DesktopError(message: "WorkBuddy 后台导航控件不支持定向操作", code: "E_BACKGROUND_UNSUPPORTED", dispatched: false)
        }
        guard let frame = axWindowRect(chosen.element), context.rect.contains(CGPoint(x: frame.midX, y: frame.midY)) else { throw DesktopError(message: "WorkBuddy 导航需要视觉定位") }
        let point = CGPoint(x: frame.midX, y: frame.midY)
        try postMouse(.leftMouseDown, point); try postMouse(.leftMouseUp, point)
    }
    return ["performed": true, "operation": operation, "label": chosen.label]
}
func workBuddyInspect(_ request: [String: Any]) throws -> [String: Any] {
    let mode = request["mode"] as? String ?? "home"
    let (_, controls, available) = try workBuddyControls(request)
    var draftMatchesRequest = false
    if let expected = request["text"] {
        guard let text = expected as? String, workBuddyTextWithinLimit(text), workBuddyTextControlsAllowed(text) else {
            throw DesktopError(message: "WorkBuddy inspect 文本无效或超过 12000 个 UTF-16 单元")
        }
        draftMatchesRequest = available && workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent) && workBuddyModelLabelAllowed(controls.selectedModel) &&
            workBuddyTextMatches(controls.draft, expected: text)
    }
    return ["available": available, "editorCount": controls.editors.count,
            "editorFocused": workBuddyEditorFocused(controls),
            "editorRect": controls.editors.first.flatMap { axWindowRect($0) }.map(rectObject) as Any? ?? NSNull(),
            "sendButtonRect": controls.sendButtons.first.flatMap { axWindowRect($0.0) }.map(rectObject) as Any? ?? NSNull(),
            "draftMatchesRequest": draftMatchesRequest,
            "draftEmpty": workBuddyDraftIsEmpty(controls.draft, sendButtonCount: controls.sendButtons.count, sendEnabled: controls.sendEnabled),
            "selectedModel": controls.selectedModel ?? "", "sendEnabled": controls.sendEnabled,
            "homeReady": controls.homeReady, "conversationReady": controls.associationMarkerPresent,
            "associationMarkerPresent": controls.associationMarkerPresent,
            "scanComplete": controls.scanComplete, "visitedNodes": controls.visitedNodes,
            "maxDepthVisited": controls.maxDepthVisited, "depthCutoff": controls.depthCutoff,
            "markerTextFound": controls.markerTextFound, "markerFrameMissing": controls.markerFrameMissing,
            "markerFrameOutsideTarget": controls.markerFrameOutsideTarget,
            "childrenFetchErrors": controls.childrenFetchErrors]
}
// Semantic interfaces are addressed to an exact process/window, never to the
// user's current keyboard focus. WeChat is excluded at this native boundary.
func softwareBundle(_ request: [String: Any]) throws -> String {
    guard let bundle = request["bundleId"] as? String, !bundle.isEmpty, bundle.utf16.count <= 200,
          bundle.lowercased() != "com.tencent.xinwechat" else {
        throw DesktopError(message: "软件接口对象无效；微信只允许视觉键鼠", dispatched: false)
    }
    return bundle
}
func softwareInfo(_ request: [String: Any]) throws -> [String: Any] {
    let id = try softwareBundle(request)
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id), let bundle = Bundle(url: url) else {
        return ["installed": false, "bundleId": id]
    }
    var cli: [String] = [], dictionaries: [String] = []
    let fm = FileManager.default
    for relative in ["Contents/Resources/bin", "Contents/Resources/app.asar.unpacked/cli/bin"] {
        let directory = url.appendingPathComponent(relative)
        for name in (try? fm.contentsOfDirectory(atPath: directory.path)) ?? [] {
            let file = directory.appendingPathComponent(name)
            if fm.isExecutableFile(atPath: file.path) { cli.append(file.path) }
        }
    }
    if let resources = bundle.resourceURL {
        dictionaries = ((try? fm.contentsOfDirectory(atPath: resources.path)) ?? []).filter { $0.hasSuffix(".sdef") }.map { resources.appendingPathComponent($0).path }
    }
    return ["installed": true, "bundleId": bundle.bundleIdentifier ?? id,
            "name": bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent,
            "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "path": url.path, "cliCandidates": Array(cli.sorted().prefix(20)), "scriptDictionaries": dictionaries,
            "accessibilityTrusted": AXIsProcessTrusted()]
}
struct SoftwareNode { let element: AXUIElement; let data: [String: Any] }
func softwareNodes(_ root: AXUIElement) throws -> [SoftwareNode] {
    var queue: [(AXUIElement, Int)] = [(root, 0)], cursor = 0, result: [SoftwareNode] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    while cursor < queue.count {
        guard cursor < 2500, DispatchTime.now().uptimeNanoseconds < deadline else { throw DesktopError(message: "软件界面树尚未完整读取", dispatched: false) }
        let (element, depth) = queue[cursor]; cursor += 1
        AXUIElementSetMessagingTimeout(element, 0.15)
        guard let role = axAttribute(element, kAXRoleAttribute as String) as? String else { continue }
        let title = axAttribute(element, kAXTitleAttribute as String) as? String ?? ""
        let description = axAttribute(element, kAXDescriptionAttribute as String) as? String ?? ""
        let value = axAttribute(element, kAXValueAttribute as String) as? String
        var settable = DarwinBoolean(false), actionNames: CFArray?
        _ = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        _ = AXUIElementCopyActionNames(element, &actionNames)
        let actions = actionNames as? [String] ?? []
        let label = !title.isEmpty ? title : !description.isEmpty ? description : role == kAXStaticTextRole as String ? value ?? "" : ""
        if settable.boolValue || !actions.isEmpty || !label.isEmpty {
            var data: [String: Any] = ["role": role, "label": String(label.prefix(300)), "actions": actions,
                                      "settable": settable.boolValue, "enabled": (axAttribute(element, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? true]
            if let value { data["value"] = String(value.prefix(1500)); data["valueTruncated"] = value.count > 1500 }
            result.append(SoftwareNode(element: element, data: data))
        }
        if depth < 48, let children = axAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement] { queue.append(contentsOf: children.map { ($0, depth + 1) }) }
    }
    return result
}
func softwareWindow(_ request: [String: Any]) throws -> (String, WorkBuddyContext, AXUIElement) {
    let id = try softwareBundle(request)
    guard !sessionLocked(), AXIsProcessTrusted(), let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first,
          let row = windowEntries().filter({ ($0["pid"] as? Int) == Int(app.processIdentifier) && ($0["layer"] as? Int) == 0 }).max(by: {
              let a = rectFrom($0["rect"]) ?? .zero, b = rectFrom($1["rect"]) ?? .zero; return a.width*a.height < b.width*b.height
          }), let windowId = uint(row["windowId"]), let rect = rectFrom(row["rect"]),
          let window = workBuddyAXWindow(app: AXUIElementCreateApplication(app.processIdentifier), targetRect: rect) else {
        throw DesktopError(message: "软件当前没有可读取的授权窗口", dispatched: false)
    }
    if let expected = request["expected"] as? [String: Any] {
        guard expected["bundleId"] as? String == id, expected["pid"] as? Int == Int(app.processIdentifier), uint(request["windowId"]) == windowId else {
            throw DesktopError(message: "软件进程或窗口已经变化，请重新读取界面", dispatched: false)
        }
    }
    return (id, WorkBuddyContext(pid: app.processIdentifier, windowID: windowId, rect: rect), window)
}
func softwareInterface(_ request: [String: Any]) throws -> [String: Any] {
    let (id, context, window) = try softwareWindow(request)
    return ["available": true, "target": ["bundleId": id, "expected": ["bundleId": id, "pid": Int(context.pid)], "windowId": context.windowID],
            "nodes": try softwareNodes(window).map { $0.data }, "method": "background-ax"]
}
func softwareControl(_ request: [String: Any]) throws -> [String: Any] {
    let (_, _, window) = try softwareWindow(request)
    let nodes = try softwareNodes(window).filter { $0.data["role"] as? String == request["role"] as? String && $0.data["label"] as? String == request["label"] as? String }
    guard nodes.count == 1, let chosen = nodes.first, chosen.data["enabled"] as? Bool == true else {
        throw DesktopError(message: "软件控件不唯一、不可见或不可用，请重新检查", dispatched: false)
    }
    let result: AXError
    if request["action"] as? String == "press" {
        guard (chosen.data["actions"] as? [String] ?? []).contains(kAXPressAction as String) else { throw DesktopError(message: "控件不支持语义点击", code: "E_BACKGROUND_UNSUPPORTED", dispatched: false) }
        result = AXUIElementPerformAction(chosen.element, kAXPressAction as CFString)
    } else if request["action"] as? String == "setValue", let value = request["value"] as? String, let expected = request["expectedValue"] as? String {
        guard chosen.data["settable"] as? Bool == true, axAttribute(chosen.element, kAXValueAttribute as String) as? String == expected else {
            throw DesktopError(message: "编辑器原值已变化，保留主人编辑内容", dispatched: false)
        }
        result = AXUIElementSetAttributeValue(chosen.element, kAXValueAttribute as CFString, value as CFString)
        if result == .success && axAttribute(chosen.element, kAXValueAttribute as String) as? String != value {
            throw DesktopError(message: "界面输入回执尚未核实，先观察实际结果", code: "E_GUI_INPUT_UNKNOWN", dispatched: true)
        }
    } else { throw DesktopError(message: "软件控件动作无效", dispatched: false) }
    if result == .success { return ["performed": true, "method": "background-ax"] }
    let unsupported = result == .actionUnsupported || result == .attributeUnsupported || result == .notImplemented
    throw DesktopError(message: "软件界面操作未取得成功回执", code: unsupported ? "E_BACKGROUND_UNSUPPORTED" : "E_GUI_INPUT_UNKNOWN", dispatched: !unsupported)
}
// A bounded WorkBuddy-only cancellation surface. Message identity is checked
// outside editors and the sidebar; a title alone never authorizes stopping.
func workBuddyStop(_ request: [String: Any]) throws -> [String: Any] {
    let context = try validateWorkBuddyContext(request,requireFrontmost:false)
    guard AXIsProcessTrusted() else { throw DesktopError(message: "缺少辅助功能权限") }
    let marker = request["marker"] as? String
    let evidence = request["evidence"] as? String ?? ""
    let title = request["conversationTitle"] as? String ?? ""
    guard workBuddyMarkerAllowed(marker) || (!evidence.isEmpty && evidence.count <= 500 && !title.isEmpty && title.count <= 200) else { throw DesktopError(message: "缺少要停止的工作会话依据") }
    let app = AXUIElementCreateApplication(context.pid)
    guard let window = workBuddyAXWindow(app: app, targetRect: context.rect) else { throw DesktopError(message: "WorkBuddy 窗口已变化") }
    let normalize: (String) -> String = { String($0.filter { !$0.isWhitespace && $0 != "\u{FEFF}" }) }
    var queue: [(AXUIElement, Int)] = [(window,0)], cursor=0, bodyMatched=false, titleMatched=false
    var buttons: [(AXUIElement,String)] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
    while cursor < queue.count {
        guard cursor < 2500, DispatchTime.now().uptimeNanoseconds < deadline else { throw DesktopError(message: "WorkBuddy 停止控件尚未完整读取") }
        let (element,depth)=queue[cursor];cursor += 1;AXUIElementSetMessagingTimeout(element,0.15)
        guard let role=axAttribute(element,kAXRoleAttribute as String) as? String else { continue }
        if role == kAXTextAreaRole as String { continue }
        let values=[kAXValueAttribute as String,kAXTitleAttribute as String,kAXDescriptionAttribute as String].compactMap { axAttribute(element,$0) as? String }
        if let rect=axWindowRect(element), rect.midX > context.rect.minX + context.rect.width * 0.32 {
            if values.contains(where: { value in marker != nil ? value.contains(marker!) : normalize(value).contains(normalize(evidence)) }) { bodyMatched=true }
        }
        if let rect=axWindowRect(element), rect.minX > context.rect.minX + 200, rect.minY < context.rect.minY + 100, values.contains(title) { titleMatched=true }
        if role == kAXButtonRole as String {
            let label=values.joined(separator:" ").trimmingCharacters(in:.whitespacesAndNewlines)
            if values.contains(where: { ["停止","停止生成","停止回答","停止响应","停止运行","Stop","Stop generating","Stop response"].contains($0) }),
               (axAttribute(element,kAXEnabledAttribute as String) as? NSNumber)?.boolValue == true { buttons.append((element,label)) }
        }
        if depth < 48, let children=axAttribute(element,kAXChildrenAttribute as String) as? [AXUIElement] { queue.append(contentsOf:children.map { ($0,depth+1) }) }
    }
    try revalidateWorkBuddyContext(request,context,requireFrontmost:false)
    let matched=bodyMatched && (marker != nil || titleMatched)
    if request["inspect"] as? Bool == true { return ["matched":matched,"stopCount":buttons.count] }
    guard matched else { throw DesktopError(message: "当前对话与要停止的任务不匹配，未操作其他会话") }
    guard buttons.count == 1 else { throw DesktopError(message: "尚未找到唯一可用的 WorkBuddy 停止按钮") }
    let button=buttons[0].0
    try revalidateWorkBuddyContext(request,context,requireFrontmost:false)
    if AXUIElementPerformAction(button,kAXPressAction as CFString) != .success {
        try revalidateWorkBuddyContext(request,context)
        guard let rect=axWindowRect(button), context.rect.contains(CGPoint(x:rect.midX,y:rect.midY)) else { throw DesktopError(message:"停止按钮需要重新视觉定位") }
        try postMouse(.leftMouseDown,CGPoint(x:rect.midX,y:rect.midY));try postMouse(.leftMouseUp,CGPoint(x:rect.midX,y:rect.midY))
    }
    return ["performed":true]
}
func workBuddyPayload(_ request: [String: Any]) throws -> (String, String) {
    guard let text = request["text"] as? String, !text.isEmpty, workBuddyTextWithinLimit(text), workBuddyTextControlsAllowed(text),
          let model = request["model"] as? String else { throw DesktopError(message: "WorkBuddy 文本无效或超过 12000 个 UTF-16 单元") }
    guard model == "deepseek-v4.1-flash" else { throw DesktopError(message: "AX 仅允许精确模型 deepseek-v4.1-flash") }
    return (text, model)
}
func workBuddyReadbackFlags(actual: String?, expected: String) -> (matches: Bool, trailingNewline: Bool, whitespaceOnly: Bool, actualLength: Int) {
    guard let actual else { return (false, false, false, -1) }
    let withoutOneBOM = actual.hasPrefix("\u{FEFF}") ? String(actual.dropFirst()) : actual
    let trailing = workBuddyTextMatches(actual, expected: expected + "\n")
    let whitespaceOnly = withoutOneBOM != expected &&
        withoutOneBOM.trimmingCharacters(in: .whitespacesAndNewlines) == expected.trimmingCharacters(in: .whitespacesAndNewlines)
    return (workBuddyTextMatches(actual, expected: expected), trailing, whitespaceOnly, actual.utf16.count)
}
func workBuddyEditorFocused(_ controls: WorkBuddyControls) -> Bool {
    guard let app = controls.application,
          let focused = axElementAttribute(app, kAXFocusedUIElementAttribute as String) else { return false }
    return controls.editorFocusElements.contains { CFEqual($0, focused) }
}
func focusWorkBuddyEditor(_ request: [String: Any], context: WorkBuddyContext, controls: WorkBuddyControls, editor: AXUIElement) throws {
    guard CGPreflightPostEventAccess() else { throw DesktopError(message: "缺少输入控制权限，未向编辑器写入文本") }
    AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let focusDeadline = DispatchTime.now().uptimeNanoseconds + 250_000_000
    while DispatchTime.now().uptimeNanoseconds < focusDeadline {
        if workBuddyEditorFocused(controls) { return }
        usleep(25_000)
    }
    guard let editorRect = axWindowRect(editor), editorRect.width > 0, editorRect.height > 0,
          editorRect.minX >= context.rect.minX, editorRect.minY >= context.rect.minY,
          editorRect.maxX <= context.rect.maxX, editorRect.maxY <= context.rect.maxY else {
        throw DesktopError(message: "无法确认 WorkBuddy 编辑器焦点，且编辑框几何不在目标窗口内")
    }
    let center = CGPoint(x: editorRect.midX, y: editorRect.midY)
    try revalidateWorkBuddyContext(request, context)
    try postMouse(.leftMouseDown, center); try postMouse(.leftMouseUp, center)
    try revalidateWorkBuddyContext(request, context)
    let clickDeadline = DispatchTime.now().uptimeNanoseconds + 250_000_000
    while DispatchTime.now().uptimeNanoseconds < clickDeadline {
        if workBuddyEditorFocused(controls) { return }
        usleep(25_000)
    }
    throw DesktopError(message: "无法确认 WorkBuddy 编辑器已获得焦点，未发送文本")
}
func workBuddyInputStillTargeted(_ request: [String: Any], context: WorkBuddyContext, controls: WorkBuddyControls, combo: AXUIElement) throws {
    try revalidateWorkBuddyContext(request, context)
    guard workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String),
          workBuddyEditorFocused(controls) else { throw DesktopError(message: "WorkBuddy 模型或输入焦点已变化，停止输入") }
}
func workBuddyFill(_ request: [String: Any]) throws -> [String: Any] {
    let (text, model) = try workBuddyPayload(request)
    let background = request["background"] as? Bool == true
    let mode = request["mode"] as? String ?? "home"
    let (context, controls, available) = try workBuddyControls(request)
    guard available, workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent), controls.editors.count == 1,
          workBuddyModelAllowed(model, selectedModel: controls.selectedModel), let editor = controls.editors.first else {
        throw DesktopError(message: "WorkBuddy 编辑器、首页或 Flash 模型状态未确认")
    }
    let expectedText = text
    switch workBuddyDraftPlan(current: controls.draft, requested: expectedText,
                              sendButtonCount: controls.sendButtons.count, sendEnabled: controls.sendEnabled) {
    case .reject: throw DesktopError(message: "WorkBuddy 草稿非空且与请求不同，已保留原内容", code: "E_WORKBUDDY_DRAFT_CONFLICT", dispatched: false)
    case .alreadyFilled, .write: break
    }
    let plan = try makeInputPlan(text, lineBreak: "shiftEnter")
    guard let combo = controls.combos.first?.0,
          workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String) else {
        throw DesktopError(message: "WorkBuddy 模型已变化，草稿未写入")
    }
    let latestSendEnabled = (controls.sendButtons.first.map { axAttribute($0.0, kAXEnabledAttribute as String) as? NSNumber } ?? nil)?.boolValue ?? true
    switch workBuddyDraftPlan(current: axAttribute(editor, kAXValueAttribute as String) as? String, requested: expectedText,
                              sendButtonCount: controls.sendButtons.count, sendEnabled: latestSendEnabled) {
    case .reject: throw DesktopError(message: "WorkBuddy 草稿已变化且非空，已保留原内容", code: "E_WORKBUDDY_DRAFT_CONFLICT", dispatched: false)
    case .alreadyFilled, .write: break
    }
    if background {
        try revalidateWorkBuddyContext(request, context, requireFrontmost: false)
        guard CGPreflightPostEventAccess() else { throw DesktopError(message: "缺少定向输入权限", code: "E_BACKGROUND_UNSUPPORTED", dispatched: false) }
        AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let focusDeadline = DispatchTime.now().uptimeNanoseconds + 250_000_000
        while !workBuddyEditorFocused(controls) && DispatchTime.now().uptimeNanoseconds < focusDeadline { usleep(25_000) }
        guard workBuddyEditorFocused(controls) else { throw DesktopError(message: "后台编辑器焦点不可确认", code: "E_BACKGROUND_UNSUPPORTED", dispatched: false) }
    } else {
        try focusWorkBuddyEditor(request, context: context, controls: controls, editor: editor)
    }
    // Focusing can restore the editor's controlled draft after an AX-only value
    // change. Re-read after focus before any text input; never replace a draft
    // to refresh a disabled send button. AX emptiness cannot prove that an
    // application's hidden model agrees, so the final exact readback remains
    // necessary and must not be reported as a successful fill on mismatch.
    try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
    guard workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String),
          workBuddyEditorFocused(controls) else {
        throw DesktopError(message: "WorkBuddy 模型或编辑器焦点已变化，草稿未写入", dispatched: false)
    }
    let focusedSendEnabled = (controls.sendButtons.first.map { axAttribute($0.0, kAXEnabledAttribute as String) as? NSNumber } ?? nil)?.boolValue ?? true
    switch workBuddyDraftPlan(current: axAttribute(editor, kAXValueAttribute as String) as? String, requested: expectedText,
                              sendButtonCount: controls.sendButtons.count, sendEnabled: focusedSendEnabled) {
    case .alreadyFilled:
        return ["filled": true, "idempotent": true, "verified": true, "sendEnabled": focusedSendEnabled]
    case .reject:
        throw DesktopError(message: "WorkBuddy 取得焦点后的草稿与请求不一致或不可读，已保留原内容", code: "E_WORKBUDDY_DRAFT_CONFLICT", dispatched: false)
    case .write: break
    }
    let targetPID: pid_t? = background ? context.pid : nil
    do {
        for item in plan {
            try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
            guard workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String), workBuddyEditorFocused(controls) else { throw DesktopError(message: "定向编辑器已变化") }
            switch item {
            case .text(let units): try postUnicodeText(units, targetPID: targetPID)
            case .softLineBreak: try postShiftReturn(targetPID: targetPID)
            }
        }
    } catch {
        throw DesktopError(message: "WorkBuddy 输入中断，草稿可能部分更新；未自动重试或发送")
    }
    let waitDeadline = DispatchTime.now().uptimeNanoseconds + 800_000_000
    var finalReadback: String?
    repeat {
        try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
        guard workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String) else {
            throw DesktopError(message: "WorkBuddy 模型已变化，输入结束但不会发送")
        }
        finalReadback = axAttribute(editor, kAXValueAttribute as String) as? String
        if workBuddyReadbackFlags(actual: finalReadback, expected: expectedText).matches { break }
        if DispatchTime.now().uptimeNanoseconds >= waitDeadline { break }
        usleep(50_000)
    } while true
    let readback = workBuddyReadbackFlags(actual: finalReadback, expected: expectedText)
    guard readback.matches else {
        return ["filled": false, "resultUncertain": true, "verified": false,
                "expectedLength": expectedText.utf16.count, "actualLength": readback.actualLength,
                "trailingNewlineDifference": readback.trailingNewline,
                "whitespaceDifference": readback.whitespaceOnly]
    }
    try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
    return ["filled": true, "idempotent": false, "verified": true, "inputChunks": plan.count,
            "readbackLength": readback.actualLength, "trailingNewlineDifference": false,
            "whitespaceDifference": readback.whitespaceOnly]
}
// AX supplies only the target geometry. The actual submit uses one physical-style
// mouse click; reject missing, invalid, clipped or off-window button rectangles.
func workBuddySendPoint(buttonRect: CGRect?, windowRect: CGRect) -> CGPoint? {
    guard let rect = buttonRect,
          [rect.minX, rect.minY, rect.width, rect.height, rect.maxX, rect.maxY,
           windowRect.minX, windowRect.minY, windowRect.maxX, windowRect.maxY].allSatisfy({ $0.isFinite }),
          rect.width > 0, rect.height > 0, windowRect.width > 0, windowRect.height > 0,
          rect.minX >= windowRect.minX, rect.minY >= windowRect.minY,
          rect.maxX <= windowRect.maxX, rect.maxY <= windowRect.maxY else { return nil }
    return CGPoint(x: rect.midX, y: rect.midY)
}
func approvedWorkBuddySendPoint(_ request: [String: Any], buttonRect: CGRect?, windowRect: CGRect) throws -> CGPoint {
    guard let approval = request["approvedPointer"] as? [String: Any],
          let approvedRect = rectFrom(approval["rect"]), let expectedPoint = approval["point"] as? [String: Any],
          let x = number(expectedPoint["x"]), let y = number(expectedPoint["y"]), x.isFinite, y.isFinite,
          let currentRect = buttonRect, currentRect == approvedRect,
          let actualPoint = workBuddySendPoint(buttonRect: currentRect, windowRect: windowRect),
          actualPoint == CGPoint(x: x, y: y) else {
        throw DesktopError(message: "发送按钮或已核对指针位置已变化，本次未派发", code: "E_GUI_POINTER_CHANGED", dispatched: false,
            diagnostic: ["operation": "submit", "method": "foreground-pointer"])
    }
    return actualPoint
}
func workBuddySend(_ request: [String: Any]) throws -> [String: Any] {
    let (text, model) = try workBuddyPayload(request)
    let background = request["background"] as? Bool == true
    let mode = request["mode"] as? String ?? "home"
    let (context, controls, available) = try workBuddyControls(request)
    let preflight = workBuddySendGuardPlan(scanComplete: controls.scanComplete, childrenFetchErrors: controls.childrenFetchErrors,
        editorCount: controls.editors.count,
        targetReady: workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent),
        modelMatched: controls.combos.count == 1 && workBuddyModelAllowed(model, selectedModel: controls.selectedModel),
        draft: controls.draft, requested: text, sendButtonCount: controls.sendButtons.count, sendEnabled: controls.sendEnabled)
    guard available, preflight.ready, let editor = controls.editors.first else {
        throw DesktopError(message: preflight.conflictingDraft ? "WorkBuddy 草稿与本任务原文不同，已保留且未提交" : "WorkBuddy 草稿、首页、Flash 模型或发送状态未确认",
            code: preflight.conflictingDraft ? "E_WORKBUDDY_DRAFT_CONFLICT" : "E_GUI_BEFORE_DISPATCH", dispatched: false,
            diagnostic: workBuddySendGuardDiagnostic(preflight, background: background, sendButtonCount: controls.sendButtons.count))
    }
    guard let button = controls.sendButtons.first?.0, let combo = controls.combos.first?.0 else { throw DesktopError(message: "发送按钮或模型控件不可用") }
    try revalidateWorkBuddyContext(request, context, requireFrontmost: !background)
    guard workBuddyTextMatches(axAttribute(editor, kAXValueAttribute as String) as? String, expected: text),
          workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String),
          axAttribute(button, kAXEnabledAttribute as String) as? Bool == true else {
        throw DesktopError(message: "WorkBuddy 草稿或发送状态已变化")
    }
    if background {
        let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
        if result == .success { return ["pressed": true, "method": "background-ax"] }
        if result == .actionUnsupported || result == .notImplemented {
            throw DesktopError(message: "WorkBuddy 不支持后台发送", code: "E_BACKGROUND_UNSUPPORTED", dispatched: false)
        }
        throw DesktopError(message: "后台发送回执待核对，不重复发送", code: "E_GUI_SEND_UNKNOWN", dispatched: true)
    }
    guard CGPreflightPostEventAccess(), let buttonRect = axWindowRect(button) else {
        throw DesktopError(message: "发送按钮几何不完整或缺少输入控制权限；未发送", code: "E_GUI_BEFORE_DISPATCH", dispatched: false)
    }
    let clickPoint = try approvedWorkBuddySendPoint(request, buttonRect: buttonRect, windowRect: context.rect)
    guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: clickPoint, mouseButton: .left),
          let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: clickPoint, mouseButton: .left) else {
        throw DesktopError(message: "无法创建发送鼠标事件；未发送", code: "E_GUI_BEFORE_DISPATCH", dispatched: false)
    }
    try revalidateWorkBuddyContext(request, context)
    guard let app = controls.application,
          let focusedWindow = axElementAttribute(app, kAXFocusedWindowAttribute as String),
          let focusedRect = axWindowRect(focusedWindow), rectsMatch(focusedRect, context.rect),
          let currentButtonRect = axWindowRect(button),
          workBuddyTextMatches(axAttribute(editor, kAXValueAttribute as String) as? String, expected: text),
          workBuddyModelLabelAllowed(axAttribute(combo, kAXValueAttribute as String) as? String),
          axAttribute(button, kAXEnabledAttribute as String) as? Bool == true else {
        throw DesktopError(message: "发送按钮、草稿或模型已变化；未发送", code: "E_GUI_BEFORE_DISPATCH", dispatched: false)
    }
    _ = try approvedWorkBuddySendPoint(request, buttonRect: currentButtonRect, windowRect: context.rect)
    try revalidateWorkBuddyContext(request, context)
    mouseDown.post(tap: .cghidEventTap)
    mouseUp.post(tap: .cghidEventTap)
    let postContextIsValid = (try? revalidateWorkBuddyContext(request, context)) != nil
    return ["pressed": true, "method": "foreground-pointer", "point": ["x": clickPoint.x, "y": clickPoint.y], "postContextValid": postContextIsValid]
}
func unicodeChunks(_ value: String, limit: Int = 20) -> [[UInt16]] {
    var chunks: [[UInt16]] = []
    var current: [UInt16] = []
    for scalar in value.unicodeScalars {
        let units = Array(String(scalar).utf16)
        if !current.isEmpty && current.count + units.count > limit {
            chunks.append(current); current = []
        }
        current.append(contentsOf: units)
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks
}
enum DesktopInputEvent: Equatable {
    case text([UInt16])
    case softLineBreak
}
func makeInputPlan(_ value: String, lineBreak: Any? = nil) throws -> [DesktopInputEvent] {
    if let lineBreak, !(lineBreak as? String == "shiftEnter") {
        throw DesktopError(message: "lineBreak 只支持 shiftEnter")
    }
    let normalized = value.replacingOccurrences(of: "\r\n", with: "\n")
    let hasBreak = normalized.contains("\n")
    if hasBreak && (lineBreak as? String) != "shiftEnter" {
        throw DesktopError(message: "多行输入必须显式设置 lineBreak: shiftEnter")
    }
    guard !normalized.unicodeScalars.contains(where: { scalar in
        (scalar.value <= 0x1f && scalar.value != 0x0a) || scalar.value == 0x7f
    }) else { throw DesktopError(message: "输入包含不支持的控制字符（Tab 和 CR 必须移除）") }
    let pieces = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    var plan: [DesktopInputEvent] = []
    for (index, piece) in pieces.enumerated() {
        plan.append(contentsOf: unicodeChunks(String(piece)).map(DesktopInputEvent.text))
        if index + 1 < pieces.count { plan.append(.softLineBreak) }
    }
    return plan
}
func activeDesktopRect() -> CGRect {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return CGDisplayBounds(CGMainDisplayID()) }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return CGDisplayBounds(CGMainDisplayID()) }
    return ids.prefix(Int(count)).map(CGDisplayBounds).reduce(CGRect.null) { $0.union($1) }
}
func pngData(_ image: CGImage) throws -> Data {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { throw DesktopError(message: "PNG 编码失败") }
    return data
}
// AppKit/SCK completions may arrive on the main queue. A blocking semaphore on
// the request thread would starve them, including first launch of a target app.
func waitWithRunLoop(_ semaphore: DispatchSemaphore, seconds: Double) -> Bool {
    let deadline = Date(timeIntervalSinceNow: seconds)
    while Date() < deadline {
        if semaphore.wait(timeout: .now()) == .success { return true }
        _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
    return semaphore.wait(timeout: .now()) == .success
}
func writePrivatePNG(_ data: Data) throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("workbunny-desktop-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let dirFD = dir.path.withCString { open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW) }
    guard dirFD >= 0 else { throw DesktopError(message: "无法安全打开临时截图目录") }
    defer { _ = close(dirFD) }
    var dirStat = stat()
    guard fstat(dirFD, &dirStat) == 0, (dirStat.st_mode & S_IFMT) == S_IFDIR,
          (dirStat.st_mode & 0o777) == 0o700 else { throw DesktopError(message: "临时截图目录不安全") }
    let fileFD = openat(dirFD, "capture.png", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fileFD >= 0 else { throw DesktopError(message: "无法安全创建临时截图文件") }
    defer { _ = close(fileFD) }
    guard fchmod(fileFD, 0o600) == 0 else { throw DesktopError(message: "无法设置临时截图文件权限") }
    try data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let written = Darwin.write(fileFD, base.advanced(by: offset), raw.count - offset)
            if written < 0 && errno == EINTR { continue }
            guard written > 0 else { throw DesktopError(message: "写入临时截图失败") }
            offset += written
        }
    }
    return dir.appendingPathComponent("capture.png").path
}
final class LegacyScreenshot: NSObject, SCStreamOutput, SCStreamDelegate {
    let lock = NSLock()
    var continuation: CheckedContinuation<CGImage, Error>?
    var stream: SCStream?
    func finish(_ result: Result<CGImage, Error>) {
        lock.lock(); let c = continuation; continuation = nil; lock.unlock()
        guard let c else { return }; c.resume(with: result)
        if let stream { Task { try? await stream.stopCapture() } }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { finish(.failure(error)) }
    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, buffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: status) == .complete,
              let pixel = buffer.imageBuffer else { return }
        let image = CIImage(cvPixelBuffer: pixel)
        guard let cg = CIContext().createCGImage(image, from: image.extent) else { return }
        finish(.success(cg))
    }
    func capture(filter: SCContentFilter, config: SCStreamConfiguration) async throws -> CGImage {
        try await withCheckedThrowingContinuation { c in
            continuation = c
            let capture = SCStream(filter: filter, configuration: config, delegate: self); stream = capture
            do {
                try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "workbunny.capture"))
                Task { do { try await capture.startCapture() } catch { self.finish(.failure(error)) } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 8) { self.finish(.failure(DesktopError(message: "截图超时"))) }
            } catch { finish(.failure(error)) }
        }
    }
}
func legacyPixelScale(_ rect: CGRect) -> CGFloat {
    var display = CGMainDisplayID(), count: UInt32 = 0
    _ = CGGetDisplaysWithRect(rect, 1, &display, &count)
    return CGFloat(CGDisplayPixelsWide(display)) / max(1, CGDisplayBounds(display).width)
}
// A display crop may be used only when the target is the frontmost app and no
// visible window above it intersects the requested frame. No app UI is read.
func unobscuredFrontWindow(_ windowId: UInt32) throws -> (Int, CGRect) {
    let rows = windowEntries()
    guard let index = rows.firstIndex(where: { ($0["windowId"] as? UInt32) == windowId }),
          let pid = rows[index]["pid"] as? Int, let rect = rectFrom(rows[index]["rect"]),
          (rows[index]["layer"] as? Int) == 0,
          let front = currentFrontmost(), Int(front.processIdentifier) == pid else {
        throw DesktopError(message: "整屏裁切要求目标窗口属于前台应用")
    }
    for row in rows.prefix(index) {
        guard let other = rectFrom(row["rect"]) else { throw DesktopError(message: "无法核实窗口遮挡") }
        if rectIntersects(other, rect) { throw DesktopError(message: "目标窗口可能被遮挡，不能使用整屏裁切") }
    }
    return (pid, rect)
}
func displayCropPixelRect(_ rect: CGRect, displayRect: CGRect, imageWidth: Int, imageHeight: Int) -> CGRect? {
    guard displayRect.width > 0, displayRect.height > 0, displayRect.contains(rect), imageWidth > 0, imageHeight > 0 else { return nil }
    let sx = CGFloat(imageWidth) / displayRect.width, sy = CGFloat(imageHeight) / displayRect.height
    let x = (rect.minX - displayRect.minX) * sx, y = (rect.minY - displayRect.minY) * sy
    let right = (rect.maxX - displayRect.minX) * sx, bottom = (rect.maxY - displayRect.minY) * sy
    guard [sx, sy, x, y, right, bottom].allSatisfy({ $0.isFinite }), sx > 0, sy > 0 else { return nil }
    let result = CGRect(x: floor(x), y: floor(y), width: ceil(right) - floor(x), height: ceil(bottom) - floor(y))
    guard result.width > 0, result.height > 0, result.minX >= 0, result.minY >= 0,
          result.maxX <= CGFloat(imageWidth), result.maxY <= CGFloat(imageHeight) else { return nil }
    return result
}
func displayCropSharingAllowed(_ sharing: Int?) -> Bool { sharing != nil && sharing != 0 }
func captureDisplayCrop(_ windowId: UInt32, content: SCShareableContent) async throws -> (CGImage, CGRect) {
    // Sharing metadata alone must never reject a successful window capture.
    // After that capture fails/times out, however, a non-shared or unknown
    // window cannot be safely reconstructed from pixels of the desktop behind it.
    let sharing = windowEntries().first(where: { ($0["windowId"] as? UInt32) == windowId })?["sharingState"] as? Int
    guard displayCropSharingAllowed(sharing) else {
        throw CaptureUnavailableError(message: "当前窗口截图不可用或受到系统截图限制；已停止视觉操作")
    }
    let (pid, rect) = try unobscuredFrontWindow(windowId)
    guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(rect) }) else {
        throw DesktopError(message: "目标窗口跨显示器或不在可用显示器内，不能整屏裁切")
    }
    let displayRect = CGDisplayBounds(display.displayID)
    guard displayRect.width > 0, displayRect.height > 0 else { throw DesktopError(message: "显示器几何无效") }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let config = makeCaptureConfiguration(width: display.width, height: display.height, fitWindow: false)
    let image: CGImage
    if #available(macOS 14.0, *) { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    else { image = try await LegacyScreenshot().capture(filter: filter, config: config) }
    let (afterPID, afterRect) = try unobscuredFrontWindow(windowId)
    guard afterPID == pid, rectsMatch(rect, afterRect), image.width > 0, image.height > 0 else {
        throw DesktopError(message: "整屏截图期间目标窗口或几何已变化")
    }
    guard let pixelRect = displayCropPixelRect(rect, displayRect: displayRect, imageWidth: image.width, imageHeight: image.height),
          let cropped = image.cropping(to: pixelRect), cropped.width > 0, cropped.height > 0 else {
        throw DesktopError(message: "整屏截图裁切尺寸或坐标无效")
    }
    return (cropped, rect)
}
func captureImage(_ windowId: UInt32?, preferDisplayCrop: Bool = false, stage: @escaping (String) -> Void = { _ in }) async throws -> (CGImage, CGRect) {
    stage("窗口枚举")
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    if preferDisplayCrop, let windowId { stage("整屏采集"); return try await captureDisplayCrop(windowId, content: content) }
    let filter: SCContentFilter
    let rect: CGRect
    let width: Int
    let height: Int
    var fitsWindow = false
    if let windowId {
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else { throw DesktopError(message: "目标窗口已关闭或不可见") }
        guard let row = windowEntries().first(where: { ($0["windowId"] as? UInt32) == windowId }),
              let cgRect = rectFrom(row["rect"]) else { throw DesktopError(message: "目标窗口几何信息不可用") }
        filter = SCContentFilter(desktopIndependentWindow: window)
        // Use the same CGRect source exposed by frontmost.windows so callers can
        // map desktop points to the captured image without a second origin system.
        rect = cgRect
        guard let size = capturePixelSize(rect: rect, pointPixelScale: ( { if #available(macOS 14.0, *) { return CGFloat(filter.pointPixelScale) }; return legacyPixelScale(rect) }() )) else {
            throw DesktopError(message: "目标窗口截图尺寸无效")
        }
        width = size.width; height = size.height
        fitsWindow = true
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw DesktopError(message: "找不到可用显示器")
        }
        filter = SCContentFilter(display: display, excludingWindows: [])
        rect = CGDisplayBounds(display.displayID)
        width = display.width; height = display.height
    }
    let config = makeCaptureConfiguration(width: width, height: height, fitWindow: fitsWindow)
    let image: CGImage
    stage("图像采集")
    do {
        if #available(macOS 14.0, *) { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        else { image = try await LegacyScreenshot().capture(filter: filter, config: config) }
    } catch {
        guard let windowId else { throw error }
        stage("整屏采集")
        return try await captureDisplayCrop(windowId, content: content)
    }
    return (image, rect)
}

func capturePixelSize(rect: CGRect, pointPixelScale: CGFloat) -> (width: Int, height: Int)? {
    guard rect.width.isFinite, rect.height.isFinite, rect.width > 0, rect.height > 0,
          pointPixelScale.isFinite, pointPixelScale > 0 else { return nil }
    let width = ceil(rect.width * pointPixelScale), height = ceil(rect.height * pointPixelScale)
    guard width.isFinite, height.isFinite, width <= CGFloat(Int.max), height <= CGFloat(Int.max) else { return nil }
    return (max(1, Int(width)), max(1, Int(height)))
}

func makeCaptureConfiguration(width: Int, height: Int, fitWindow: Bool) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    config.width = width; config.height = height; config.capturesAudio = false; config.showsCursor = false
    if #available(macOS 14.0, *) { config.ignoreShadowsSingleWindow = true; config.ignoreShadowsDisplay = true }
    if #available(macOS 14.0, *), fitWindow {
        config.scalesToFit = true
        config.preservesAspectRatio = true
    }
    return config
}

func recognize(_ image: CGImage, languages: [String]) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = languages
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) }
    catch { throw DesktopError(message: "图像文字识别失败：\(error.localizedDescription)") }
    return request.results ?? []
}

func normalizedTopRect(_ observation: VNRecognizedTextObservation) -> CGRect {
    let box = observation.boundingBox
    return CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height)
}

func refineHy3Rows(image: CGImage, bilingual: [VNRecognizedTextObservation], english: [VNRecognizedTextObservation]) -> [[String: Any]] {
    let priceRegex = try! NSRegularExpression(pattern: "(?i)\\d+(?:\\.\\d+)?\\s*[x×]")
    let prices = english.filter { observation in
        guard let text = observation.topCandidates(1).first?.string else { return false }
        return priceRegex.firstMatch(in: text, range: NSRange(text.startIndex..<text.endIndex, in: text)) != nil
    }
    let labels = bilingual.filter { observation in
        guard let text = observation.topCandidates(1).first?.string else { return false }
        return text.range(of: "Hy3", options: .caseInsensitive) != nil
    }
    var regions: [CGRect] = []
    for label in labels {
        let labelRect = normalizedTopRect(label)
        let labelCenter = labelRect.midY
        for price in prices {
            let priceRect = normalizedTopRect(price)
            let rowTolerance = max(0.007, max(labelRect.height, priceRect.height) * 0.7)
            guard abs(labelCenter - priceRect.midY) <= rowTolerance else { continue }
            let lineHeight = max(labelRect.height, priceRect.height)
            let minX = max(0, min(labelRect.minX, priceRect.minX) - lineHeight * 2)
            let maxX = min(1, max(labelRect.maxX, priceRect.maxX) + lineHeight * 2)
            let minY = max(0, min(labelRect.minY, priceRect.minY) - lineHeight * 0.8)
            let maxY = min(1, max(labelRect.maxY, priceRect.maxY) + lineHeight * 0.8)
            let region = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            if region.width > 0, region.height > 0, !regions.contains(where: { abs($0.midY - region.midY) < 0.002 }) {
                regions.append(region)
            }
            if regions.count >= 6 { break }
        }
        if regions.count >= 6 { break }
    }
    guard !regions.isEmpty else { return [] }
    let context = CIContext(options: [.useSoftwareRenderer: true])
    var additions: [[String: Any]] = []
    for region in regions {
        let pixelRect = CGRect(x: region.minX * CGFloat(image.width),
                               y: region.minY * CGFloat(image.height),
                               width: region.width * CGFloat(image.width),
                               height: region.height * CGFloat(image.height)).integral
        guard pixelRect.width > 0, pixelRect.height > 0,
              let crop = image.cropping(to: pixelRect) else { continue }
        let cropRegion = CGRect(x: pixelRect.minX / CGFloat(image.width), y: pixelRect.minY / CGFloat(image.height),
                                width: pixelRect.width / CGFloat(image.width), height: pixelRect.height / CGFloat(image.height))
        let scale: CGFloat = 3
        let enlarged = CIImage(cgImage: crop).transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let enlargedImage = context.createCGImage(enlarged, from: enlarged.extent) else { continue }
        for languages in [["zh-Hans", "en-US"], ["en-US"]] {
            guard let observations = try? recognize(enlargedImage, languages: languages) else { continue }
            for observation in observations {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let box = observation.boundingBox
                let globalX = cropRegion.minX + box.minX * cropRegion.width
                let globalY = cropRegion.minY + (1 - box.maxY) * cropRegion.height
                additions.append(["text": candidate.string, "confidence": Double(candidate.confidence),
                                  "x": Double(max(0, globalX)), "y": Double(max(0, globalY)),
                                  "width": Double(min(1 - globalX, box.width * cropRegion.width)),
                                  "height": Double(min(1 - globalY, box.height * cropRegion.height))])
            }
        }
    }
    return additions
}

// A detached task cannot inherit the main actor, which is occupied by the
// synchronous JSONL handler while it pumps the run loop. State is synchronized
// because a timed-out ScreenCaptureKit call may finish after its caller returns.
final class CaptureProgress: @unchecked Sendable {
    private let lock = NSLock()
    private var stageName = "窗口枚举"
    private var stageStart = DispatchTime.now().uptimeNanoseconds
    private var result: Result<(CGImage, CGRect), Error>?
    func advance(_ name: String) { lock.lock(); stageName = name; stageStart = DispatchTime.now().uptimeNanoseconds; lock.unlock() }
    func finish(_ value: Result<(CGImage, CGRect), Error>) { lock.lock(); result = value; lock.unlock() }
    func snapshot() -> (String, UInt64, Result<(CGImage, CGRect), Error>?) {
        lock.lock(); defer { lock.unlock() }; return (stageName, stageStart, result)
    }
}
func boundedCaptureImage(_ windowId: UInt32?, preferDisplayCrop: Bool = false) throws -> (CGImage, CGRect) {
    let progress = CaptureProgress()
    let worker = Task.detached {
        do { progress.finish(.success(try await captureImage(windowId, preferDisplayCrop: preferDisplayCrop, stage: { progress.advance($0) }))) }
        catch { progress.finish(.failure(error)) }
    }
    let began = DispatchTime.now().uptimeNanoseconds
    while true {
        let (stage, since, result) = progress.snapshot()
        if let result { return try result.get() }
        let now = DispatchTime.now().uptimeNanoseconds
        let limit: UInt64 = stage == "窗口枚举" ? 4_000_000_000 : 5_000_000_000
        if now - since >= limit || now - began >= 9_000_000_000 {
            worker.cancel()
            throw DesktopError(message: "截图请求超时：\(stage)")
        }
        _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
}
// Copy the system BGRA buffer while it is locked. CGImage must own its bytes
// before the stream stops. This also avoids CoreImage/Metal context startup,
// and gives the returned image a lifetime independent of the IOSurface.
func copiedBGRA(_ base: UnsafeRawPointer, width: Int, height: Int, rowBytes: Int, colorSpace: CGColorSpace = CGColorSpace(name: CGColorSpace.sRGB)!) -> CGImage? {
    guard width > 0, height > 0, width <= 16384, height <= 16384, rowBytes >= width * 4,
          rowBytes <= 131072, rowBytes * height <= 256 * 1024 * 1024,
          let provider = CGDataProvider(data: Data(bytes: base, count: rowBytes * height) as CFData) else { return nil }
    return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: rowBytes,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue).union(.byteOrder32Little),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
}
final class DisplayFrameReceiver: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var latest: (CGImage, Date)?
    func store(_ image: CGImage) { lock.lock(); latest = (image, Date()); lock.unlock() }
    func frame() -> (CGImage, Date)? { lock.lock(); defer { lock.unlock() }; return latest }
    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixel = buffer.imageBuffer else { return }
        guard CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA,
              CVPixelBufferLockBaseAddress(pixel, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(pixel, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixel) else { return }
        if let image = copiedBGRA(base, width: CVPixelBufferGetWidth(pixel), height: CVPixelBufferGetHeight(pixel), rowBytes: CVPixelBufferGetBytesPerRow(pixel), colorSpace: CVImageBufferGetColorSpace(pixel)?.takeUnretainedValue() ?? CGColorSpace(name: CGColorSpace.sRGB)!) { store(image) }
    }
}
func waitForDisplayFrame(_ receiver: DisplayFrameReceiver, seconds: Double = 2) throws -> (CGImage, Date) {
    let until = Date(timeIntervalSinceNow: seconds)
    while Date() < until {
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        if let frame = receiver.frame(), Date().timeIntervalSince(frame.1) <= 1 { return frame }
        _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
    throw DesktopError(message: "外部全屏显示流未返回新画面")
}
// These backends capture the entire display and never use an app window filter.
func traceDisplay(_ stage: String) { if ProcessInfo.processInfo.environment["BUNNY_DISPLAY_TRACE"] == "1" { fputs("display: \(stage)\n", stderr); fflush(stderr) } }
func captureExternalDisplay(region: CGRect? = nil) throws -> (CGImage, CGRect, String, Date) {
    try ensureDisplayOwnership()
    let display = CGMainDisplayID(), screen = CGDisplayBounds(CGMainDisplayID())
    let rect = region ?? screen
    guard !rect.isNull, !rect.isEmpty, [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }), screen.contains(rect) else {
        throw DesktopError(message: "显示观察区域无效或已经离开当前显示器")
    }
    traceDisplay("begin \(rect)")
    let receiver = DisplayFrameReceiver()
    let sx = Double(CGDisplayPixelsWide(display)) / screen.width, sy = Double(CGDisplayPixelsHigh(display)) / screen.height
    let width = Int(ceil(rect.width * sx)), height = Int(ceil(rect.height * sy))
    let source = rect.offsetBy(dx: -screen.minX, dy: -screen.minY)
    if let stream = CGDisplayStream(dispatchQueueDisplay: display, outputWidth: width, outputHeight: height,
        pixelFormat: Int32(kCVPixelFormatType_32BGRA), properties: [CGDisplayStream.showCursor: false,
            CGDisplayStream.colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
            CGDisplayStream.minimumFrameTime: 0.2, CGDisplayStream.sourceRect: source.dictionaryRepresentation] as CFDictionary,
        queue: DispatchQueue(label: "workbunny.display-frame"), handler: { status, _, surface, _ in
            guard status == .frameComplete, let surface else { return }
            guard IOSurfaceGetPixelFormat(surface) == kCVPixelFormatType_32BGRA,
                  IOSurfaceLock(surface, .readOnly, nil) == KERN_SUCCESS else { return }
            defer { IOSurfaceUnlock(surface, .readOnly, nil) }
            let image = copiedBGRA(IOSurfaceGetBaseAddress(surface), width: IOSurfaceGetWidth(surface), height: IOSurfaceGetHeight(surface), rowBytes: IOSurfaceGetBytesPerRow(surface))
            if let image { receiver.store(image) }
        }) {
        traceDisplay("stream created")
        if stream.start() == .success {
            traceDisplay("stream started")
            do {
                let (image, at) = try waitForDisplayFrame(receiver)
                traceDisplay("frame ready")
                stream.stop(); traceDisplay("stream stopped"); return (image, rect, "CGDisplayStream", at)
            } catch { stream.stop(); if sessionLocked() { throw error } }
        }
    }
    let fallback = DisplayFrameReceiver(), session = AVCaptureSession()
    guard let input = AVCaptureScreenInput(displayID: display) else { throw DesktopError(message: "外部全屏捕获后端均不可用") }
    input.capturesCursor = false; input.minFrameDuration = CMTime(value: 1, timescale: 10)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.setSampleBufferDelegate(fallback, queue: DispatchQueue(label: "workbunny.display-frame.fallback"))
    guard session.canAddInput(input), session.canAddOutput(output) else { throw DesktopError(message: "外部全屏备用捕获后端不可用") }
    session.addInput(input); session.addOutput(output); session.startRunning()
    defer { session.stopRunning() }
    let (full, at) = try waitForDisplayFrame(fallback)
    if region != nil {
        guard let pixels = displayCropPixelRect(rect, displayRect: screen, imageWidth: full.width, imageHeight: full.height),
              let image = full.cropping(to: pixels) else { throw DesktopError(message: "备用显示流区域裁切失败") }
        return (image, rect, "AVCaptureScreenInput", at)
    }
    return (full, screen, "AVCaptureScreenInput", at)
}
func capture(_ request: [String: Any]) throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw DesktopError(message: "缺少屏幕录制权限；请在系统设置 → 隐私与安全性 → 屏幕录制中允许 workbunny") }
    let windowId = uint(request["windowId"])
    let external = request["captureMode"] as? String == "displayStream"
    if external && windowId != nil { throw DesktopError(message: "外部全屏捕获不能携带窗口 ID") }
    if let windowId, windowEntries().contains(where: { ($0["windowId"] as? UInt32) == windowId && ($0["bundleId"] as? String) == "com.tencent.xinWeChat" }) {
        throw DesktopError(message: "微信必须使用外部全屏捕获，禁止直接截取微信窗口")
    }
    let image: CGImage, desktopRect: CGRect
    var backend = "ScreenCaptureKit", capturedAt = Date()
    if external {
        if request["region"] != nil && rectFrom(request["region"]) == nil { throw DesktopError(message: "region 矩形无效") }
        let region = rectFrom(request["region"]), relocate = request["relocate"] as? Bool == true
        let (displayImage, sourceRect, sourceBackend, sourceAt) = try captureExternalDisplay(region: relocate ? nil : region)
        backend = sourceBackend; capturedAt = sourceAt
        if relocate, let region {
            guard let pixels = displayCropPixelRect(region, displayRect: sourceRect, imageWidth: displayImage.width, imageHeight: displayImage.height),
                  let cropped = displayImage.cropping(to: pixels) else { throw DesktopError(message: "全屏中未能锁定软件窗口与菜单区域") }
            image = cropped; desktopRect = region
        } else { image = displayImage; desktopRect = sourceRect }
    }
    else { (image, desktopRect) = try boundedCaptureImage(windowId, preferDisplayCrop: request["captureMode"] as? String == "displayCrop") }
    traceDisplay("encoding \(image.width)x\(image.height)")
    let data = try pngData(image)
    traceDisplay("encoded \(data.count)")
    let scaleX = desktopRect.width > 0 ? Double(image.width) / desktopRect.width : 1
    let scaleY = desktopRect.height > 0 ? Double(image.height) / desktopRect.height : 1
    var result: [String: Any] = ["width": image.width, "height": image.height,
        "desktopRect": rectObject(desktopRect), "pixelsPerPoint": ["x": scaleX, "y": scaleY], "format": "png",
        "backend": backend, "capturedAt": capturedAt.timeIntervalSince1970 * 1000]
    let output = request["output"] as? String ?? "base64"
    if output == "base64" { result["pngBase64"] = data.base64EncodedString() }
    else if output == "tempFile" {
        result["tempFile"] = try writePrivatePNG(data)
    } else { throw DesktopError(message: "output 只支持 base64 或 tempFile") }
    return result
}

struct VisualROI: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let minChangedPixels: Int
    let minChangedRatio: Double
}

struct VisualRegionFrame {
    let width: Int
    let height: Int
    let rgba: [UInt8]
}

struct VisualFrame {
    let sampleId: String
    let windowId: UInt32
    let pid: Int
    let bundleId: String
    let desktopRect: CGRect
    let width: Int
    let height: Int
    let regions: [VisualROI]
    let pixels: [VisualRegionFrame]
}

struct VisualSampleState {
    var baseline: VisualFrame?
    var latest: VisualFrame?
}

func visualRectsMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    guard !lhs.isNull, !rhs.isNull else { return false }
    return [lhs.minX, lhs.minY, lhs.width, lhs.height].enumerated().allSatisfy { index, value in
        let other = [rhs.minX, rhs.minY, rhs.width, rhs.height][index]
        return value.isFinite && other.isFinite && abs(value - other) < 1
    }
}

var visualSampleStates: [String: VisualSampleState] = [:]
var visualSampleLRU: [String] = []
let visualSampleCapacity = 8
let visualRegionMaxSide = 320
let visualImageMaxPixels = 16_000_000

func visualSampleId(_ value: Any?) throws -> String {
    guard let value = value as? String, !value.isEmpty, value.utf8.count <= 100 else {
        throw DesktopError(message: "sampleId 必须是 1 至 100 字符")
    }
    return value
}

func normalizedVisualRegions(_ value: Any?, defaultMinChangedRatio: Double = 0.001) throws -> [VisualROI] {
    guard let rows = value as? [[String: Any]], (1...4).contains(rows.count) else {
        throw DesktopError(message: "regions 必须包含 1 至 4 个归一化矩形")
    }
    return try rows.map { row in
        guard let x = number(row["x"]), let y = number(row["y"]),
              let width = number(row["width"]), let height = number(row["height"]),
              [x, y, width, height].allSatisfy({ $0.isFinite }),
              x >= 0, y >= 0, width > 0, height > 0, x + width <= 1, y + height <= 1 else {
            throw DesktopError(message: "ROI 必须位于 0..1 归一化窗口范围内")
        }
        let pixels = row["minChangedPixels"] == nil ? 0 : number(row["minChangedPixels"])
        let ratio = row["minChangedRatio"] == nil ? defaultMinChangedRatio : number(row["minChangedRatio"])
        guard let pixels, pixels.isFinite, pixels.rounded() == pixels, (0...102_400).contains(pixels),
              let ratio, ratio.isFinite, (0...1).contains(ratio) else {
            throw DesktopError(message: "ROI 变化门槛不合法")
        }
        return VisualROI(x: x, y: y, width: width, height: height,
                         minChangedPixels: Int(pixels), minChangedRatio: ratio)
    }
}

func visualParameters(_ request: [String: Any]) throws -> (String, UInt32, [VisualROI], Bool, Int, Double, [String: Any]?) {
    let id = try visualSampleId(request["sampleId"])
    guard let windowId = uint(request["windowId"]), windowId > 0 else {
        throw DesktopError(message: "visualSample 需要有效 windowId")
    }
    if let reset = request["reset"], !(reset is Bool) { throw DesktopError(message: "reset 必须是布尔值") }
    if let include = request["includeImage"], !(include is Bool) { throw DesktopError(message: "includeImage 必须是布尔值") }
    let thresholdValue = number(request["pixelThreshold"]) ?? 18
    guard thresholdValue.isFinite, thresholdValue.rounded() == thresholdValue, (0...255).contains(thresholdValue) else {
        throw DesktopError(message: "pixelThreshold 必须是 0 至 255 的整数")
    }
    let ratio = number(request["minChangedRatio"]) ?? 0.001
    guard ratio.isFinite, (0...1).contains(ratio) else { throw DesktopError(message: "minChangedRatio 必须位于 0..1") }
    let regions = try normalizedVisualRegions(request["regions"], defaultMinChangedRatio: ratio)
    let expected = request["expected"] as? [String: Any]
    if request["expected"] != nil {
        guard let expected, let bundle = expected["bundleId"] as? String, !bundle.isEmpty,
              let pid = expected["pid"] as? Int, pid > 0 else {
            throw DesktopError(message: "expected 必须包含有效 bundleId 和 pid")
        }
        _ = bundle; _ = pid
    }
    return (id, windowId, regions, request["reset"] as? Bool ?? false, Int(thresholdValue), ratio, expected)
}

func downsampleVisualRegion(_ image: CGImage, roi: VisualROI) throws -> VisualRegionFrame {
    let full = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    let requested = CGRect(x: roi.x * Double(image.width), y: roi.y * Double(image.height),
                           width: roi.width * Double(image.width), height: roi.height * Double(image.height)).integral
    let pixelRect = requested.intersection(full)
    guard !pixelRect.isNull, pixelRect.width >= 1, pixelRect.height >= 1,
          let crop = image.cropping(to: pixelRect) else { throw DesktopError(message: "ROI 像素范围无效") }
    let width = max(1, min(visualRegionMaxSide, crop.width))
    let height = max(1, min(visualRegionMaxSide, crop.height))
    let bytesPerRow = width * 4
    var rgba = [UInt8](repeating: 0, count: bytesPerRow * height)
    let rendered = rgba.withUnsafeMutableBytes { raw -> Bool in
        guard let base = raw.baseAddress,
              let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: bytesPerRow, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
        context.interpolationQuality = .low
        context.draw(crop, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    guard rendered else { throw DesktopError(message: "ROI 像素采样失败") }
    return VisualRegionFrame(width: width, height: height, rgba: rgba)
}

func visualChangedMask(_ baseline: VisualRegionFrame, _ current: VisualRegionFrame, threshold: Int) -> [Bool] {
    guard baseline.width == current.width, baseline.height == current.height,
          baseline.rgba.count == current.rgba.count, baseline.width > 0, baseline.height > 0 else { return [] }
    let total = baseline.width * baseline.height
    var mask = [Bool](repeating: false, count: total)
    for pixel in 0..<total {
        let offset = pixel * 4
        mask[pixel] = abs(Int(baseline.rgba[offset]) - Int(current.rgba[offset])) > threshold ||
          abs(Int(baseline.rgba[offset + 1]) - Int(current.rgba[offset + 1])) > threshold ||
          abs(Int(baseline.rgba[offset + 2]) - Int(current.rgba[offset + 2])) > threshold
    }
    return mask
}

func visualMaskMetrics(_ mask: [Bool]) -> (ratio: Double, changedPixels: Int, totalPixels: Int) {
    let changed = mask.reduce(into: 0) { if $1 { $0 += 1 } }
    return (mask.isEmpty ? 1 : Double(changed) / Double(mask.count), changed, mask.count)
}

func visualMaskOverlap(_ lhs: [Bool], _ rhs: [Bool]) -> Int {
    guard !lhs.isEmpty, lhs.count == rhs.count else { return 0 }
    return zip(lhs, rhs).reduce(into: 0) { if $1.0 && $1.1 { $0 += 1 } }
}

func compareVisualRegion(_ baseline: VisualRegionFrame, _ current: VisualRegionFrame, threshold: Int) -> (ratio: Double, changedPixels: Int, totalPixels: Int) {
    visualMaskMetrics(visualChangedMask(baseline, current, threshold: threshold))
}

func visualGeometryMatches(_ lhs: VisualFrame, _ rhs: VisualFrame) -> Bool {
    lhs.windowId == rhs.windowId && lhs.pid == rhs.pid && lhs.bundleId == rhs.bundleId &&
      lhs.width == rhs.width && lhs.height == rhs.height && visualRectsMatch(lhs.desktopRect, rhs.desktopRect) &&
      lhs.regions == rhs.regions && lhs.pixels.count == rhs.pixels.count &&
      zip(lhs.pixels, rhs.pixels).allSatisfy { $0.width == $1.width && $0.height == $1.height }
}

func touchVisualSample(_ id: String) {
    visualSampleLRU.removeAll { $0 == id }
    visualSampleLRU.append(id)
}

func ensureVisualSampleState(_ id: String) {
    guard visualSampleStates[id] == nil else { touchVisualSample(id); return }
    while visualSampleStates.count >= visualSampleCapacity, let oldest = visualSampleLRU.first {
        visualSampleStates.removeValue(forKey: oldest)
        visualSampleLRU.removeFirst()
    }
    visualSampleStates[id] = VisualSampleState(baseline: nil, latest: nil)
    touchVisualSample(id)
}

func resetVisualBaseline(_ id: String) {
    guard var state = visualSampleStates[id] else { return }
    state.baseline = nil
    visualSampleStates[id] = state
}

func shouldIncludeVisualImage(changed: Bool, reset: Bool, geometryChanged: Bool = false, hasBaseline: Bool = true, includeImage: Bool) -> Bool {
    includeImage && (changed || reset || geometryChanged || !hasBaseline)
}

func captureVisualFrame(sampleId: String, windowId: UInt32, regions: [VisualROI], expected: [String: Any]?, forceFull: Bool = false) throws -> (VisualFrame, CGImage) {
    guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
    guard CGPreflightScreenCaptureAccess() else { throw DesktopError(message: "缺少屏幕录制权限") }
    guard let before = windowEntries().first(where: { ($0["windowId"] as? UInt32) == windowId }),
          let pid = before["pid"] as? Int, pid > 0, pid <= Int(Int32.max), let rect = rectFrom(before["rect"]),
          let app = NSRunningApplication(processIdentifier: pid_t(pid)), let bundle = app.bundleIdentifier else {
        throw DesktopError(message: "目标窗口当前不可见或进程身份不可用")
    }
    if let expected {
        guard (expected["pid"] as? Int) == pid, (expected["bundleId"] as? String) == bundle else {
            throw DesktopError(message: "目标窗口进程与 expected 身份不匹配")
        }
    }
    let image: CGImage, capturedRect: CGRect
    if bundle == "com.tencent.xinWeChat" {
        let prior = visualSampleStates[sampleId]?.latest
        let anchored = !forceFull && prior?.windowId == windowId && prior?.pid == pid &&
            prior.map { visualRectsMatch($0.desktopRect, rect) } == true
        // First observation / changed geometry starts from the whole display.
        // Only a previously captured, geometrically verified region is reused.
        let (displayImage, source, _, _) = try captureExternalDisplay(region: anchored ? rect : nil)
        if anchored { image = displayImage }
        else {
            guard let pixels = displayCropPixelRect(rect, displayRect: source, imageWidth: displayImage.width, imageHeight: displayImage.height),
                  let crop = displayImage.cropping(to: pixels) else { throw DesktopError(message: "全屏显示中未能锁定微信区域") }
            image = crop
        }
        capturedRect = rect
    } else { (image, capturedRect) = try boundedCaptureImage(windowId) }
    guard image.width > 0, image.height > 0, image.width <= visualImageMaxPixels / image.height,
          visualRectsMatch(rect, capturedRect) else { throw DesktopError(message: "截图尺寸或窗口几何无效") }
    guard let after = windowEntries().first(where: { ($0["windowId"] as? UInt32) == windowId }),
          (after["pid"] as? Int) == pid, visualRectsMatch(rect, rectFrom(after["rect"]) ?? .null),
          NSRunningApplication(processIdentifier: pid_t(pid))?.bundleIdentifier == bundle else {
        throw DesktopError(message: "采样期间目标窗口或进程身份改变")
    }
    let samples = try regions.map { try downsampleVisualRegion(image, roi: $0) }
    return (VisualFrame(sampleId: sampleId, windowId: windowId, pid: pid, bundleId: bundle,
                        desktopRect: rect, width: image.width, height: image.height, regions: regions, pixels: samples), image)
}

func visualSample(_ request: [String: Any]) throws -> [String: Any] {
    let (id, windowId, regions, reset, threshold, _, expected) = try visualParameters(request)
    ensureVisualSampleState(id)
    if reset { resetVisualBaseline(id) }
    let (frame, image) = try captureVisualFrame(sampleId: id, windowId: windowId, regions: regions, expected: expected, forceFull: request["relocate"] as? Bool == true)
    var state = visualSampleStates[id] ?? VisualSampleState(baseline: nil, latest: nil)
    let baseline = state.baseline
    let previousSample = state.latest
    let geometryChanged = baseline.map { !visualGeometryMatches($0, frame) } ?? false
    let hasBaseline = baseline != nil && !reset
    var changed = false
    var measurements: [[String: Any]] = []
    for index in frame.pixels.indices {
        let total = frame.pixels[index].width * frame.pixels[index].height
        let currentMask = hasBaseline && !geometryChanged
          ? visualChangedMask(baseline!.pixels[index], frame.pixels[index], threshold: threshold)
          : [Bool](repeating: false, count: total)
        let previousMask: [Bool]
        if hasBaseline, !geometryChanged, let previousSample, visualGeometryMatches(previousSample, frame) {
            previousMask = visualChangedMask(baseline!.pixels[index], previousSample.pixels[index], threshold: threshold)
        } else { previousMask = [Bool](repeating: false, count: total) }
        let measure = visualMaskMetrics(currentMask)
        let stablePixels = visualMaskOverlap(currentMask, previousMask)
        let stableRatio = measure.totalPixels > 0 ? Double(stablePixels) / Double(measure.totalPixels) : 0
        let region = regions[index]
        let isChanged = measure.changedPixels > 0 && measure.changedPixels >= region.minChangedPixels &&
          measure.ratio >= region.minChangedRatio && hasBaseline && !geometryChanged
        changed = changed || isChanged
        let drift: Any = previousSample.map { visualGeometryMatches($0, frame)
          ? compareVisualRegion($0.pixels[index], frame.pixels[index], threshold: threshold).ratio as Any : NSNull() } ?? NSNull()
        measurements.append(["ratio": measure.ratio, "changedPixels": measure.changedPixels, "totalPixels": measure.totalPixels,
          "sinceLastRatio": drift, "stableChangedPixels": stablePixels, "stableRatio": stableRatio,
          "minChangedPixels": region.minChangedPixels, "minChangedRatio": region.minChangedRatio])
    }
    state.latest = frame
    visualSampleStates[id] = state
    touchVisualSample(id)
    var result: [String: Any] = ["baseline": !hasBaseline, "changed": changed, "geometryChanged": geometryChanged,
      "regions": measurements, "desktopRect": rectObject(frame.desktopRect), "width": frame.width, "height": frame.height]
    if shouldIncludeVisualImage(changed: changed, reset: reset, geometryChanged: geometryChanged,
                                hasBaseline: hasBaseline, includeImage: request["includeImage"] as? Bool ?? false) {
        let data = try pngData(image)
        guard data.count <= 40 * 1024 * 1024 else { throw DesktopError(message: "视觉采样 PNG 超过 40 MiB 输出限制") }
        result["pngBase64"] = data.base64EncodedString()
    }
    return result
}

func visualCommit(_ request: [String: Any]) throws -> [String: Any] {
    let id = try visualSampleId(request["sampleId"])
    guard var state = visualSampleStates[id], let latest = state.latest else {
        throw DesktopError(message: "没有可提交的视觉采样；请先调用 visualSample")
    }
    state.baseline = latest
    visualSampleStates[id] = state
    touchVisualSample(id)
    return ["committed": true, "sampleId": id]
}

func visualForget(_ request: [String: Any]) throws -> [String: Any] {
    let id = try visualSampleId(request["sampleId"])
    let removed = visualSampleStates.removeValue(forKey: id) != nil
    visualSampleLRU.removeAll { $0 == id }
    return ["forgotten": removed, "sampleId": id]
}

func inputIdle() -> [String: Any] {
    let anyInput = CGEventType(rawValue: UInt32.max)!
    let hid = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)
    let combined = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    func milliseconds(_ seconds: CFTimeInterval) -> Any {
        guard seconds.isFinite, seconds >= 0 else { return NSNull() }
        return seconds * 1000
    }
    return ["hidIdleMs": milliseconds(hid), "combinedIdleMs": milliseconds(combined)]
}

func recognizePNG(_ request: [String: Any]) throws -> [String: Any] {
    guard let encoded = request["pngBase64"] as? String, !encoded.isEmpty,
          encoded.utf8.count <= 11_184_812 else { throw DesktopError(message: "pngBase64 必须是最大 8 MiB PNG 的 base64 数据") }
    guard let data = Data(base64Encoded: encoded), data.count <= 8 * 1024 * 1024,
          data.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) else {
        throw DesktopError(message: "输入必须是合法 PNG，且文件不超过 8 MiB")
    }
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          (CGImageSourceGetType(source) as String?) == "public.png",
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
          width > 0, height > 0, width <= 16_000_000, height <= 16_000_000,
          width <= 16_000_000 / height else {
        throw DesktopError(message: "PNG 像素尺寸无效或超过 1600 万像素")
    }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
          image.width == width, image.height == height else { throw DesktopError(message: "PNG 解码失败") }
    let bilingual = try recognize(image, languages: ["zh-Hans", "en-US"])
    let english = try recognize(image, languages: ["en-US"])
    var texts: [[String: Any]] = bilingual.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        let x = min(1, max(0, box.minX)), y = min(1, max(0, 1 - box.maxY))
        return ["text": candidate.string, "confidence": Double(candidate.confidence),
                "x": Double(x), "y": Double(y), "width": Double(box.width), "height": Double(box.height)]
    }
    texts.append(contentsOf: english.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return ["text": candidate.string, "confidence": Double(candidate.confidence),
                "x": Double(max(0, box.minX)), "y": Double(max(0, 1 - box.maxY)),
                "width": Double(min(box.width, 1 - box.minX)), "height": Double(min(box.height, box.maxY))]
    })
    texts.append(contentsOf: refineHy3Rows(image: image, bilingual: bilingual, english: english))
    return ["texts": texts, "width": width, "height": height]
}
func perform(_ request: [String: Any]) throws -> [String: Any] {
    guard let op = request["op"] as? String else { throw DesktopError(message: "缺少 op") }
    let submissionExpectation = try workBuddySubmissionExpectation(request)
    switch op {
    case "workbuddyCapabilities": return ["backgroundAX": true]
    case "softwareInfo": return try softwareInfo(request)
    case "taskProcessIdentity": return ["identity": taskProcessIdentity(pid_t(request["pid"] as? Int ?? 0)) ?? [:]]
    case "taskProcessStop": return try taskResourceStop(request, application: false)
    case "taskApplicationStop": return try taskResourceStop(request, application: true)
    case "taskApplicationHealth": return try taskApplicationHealth(request)
    case "taskApplicationForceStop": return try taskApplicationForceStop(request)
    case "softwareInterface": return try softwareInterface(request)
    case "softwareControl": return try softwareControl(request)
    case "permissions":
        return ["accessibilityTrusted": AXIsProcessTrusted(), "screenCaptureAllowed": CGPreflightScreenCaptureAccess(),
                "postEventAllowed": CGPreflightPostEventAccess(), "sessionLocked": sessionLocked()]
    case "requestPermission":
        let kind = request["kind"] as? String ?? "all"
        guard ["all", "screen", "accessibility", "input"].contains(kind) else { throw DesktopError(message: "权限请求类型无效") }
        let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true] as CFDictionary
        let ax = (kind == "all" || kind == "accessibility") ? AXIsProcessTrustedWithOptions(options) : AXIsProcessTrusted()
        let capture = (kind == "all" || kind == "screen") ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
        let events = (kind == "all" || kind == "input") ? CGRequestPostEventAccess() : CGPreflightPostEventAccess()
        return ["accessibilityTrusted": ax, "screenCaptureAllowed": capture, "postEventAllowed": events,
                "note": "若系統設定要求，請手動允許並重新啟動 workbunny"]
    case "frontmost": return ["application": appIdentity(currentFrontmost()), "windows": windowEntries()]
    case "inputIdle": return inputIdle()
    case "recognize": return try recognizePNG(request)
    case "visualSample": return try visualSample(request)
    case "visualCommit": return try visualCommit(request)
    case "visualForget": return try visualForget(request)
    case "workbuddyNavigate": return try workBuddyNavigation(request)
    case "workbuddyInspect": return try workBuddyInspect(request)
    case "workbuddyStop": return try workBuddyStop(request)
    case "workbuddyFill": return try workBuddyFill(request)
    case "workbuddySend":
        do { return try workBuddySend(request) }
        catch let error as DesktopError {
            throw DesktopError(message: error.message, code: error.code ?? "E_GUI_BEFORE_DISPATCH", dispatched: error.dispatched ?? false, diagnostic: error.diagnostic)
        }
    case "capture":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        return try capture(request)
    case "activate":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        guard let bundle = request["bundleId"] as? String, !bundle.isEmpty else { throw DesktopError(message: "缺少 bundleId") }
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
            guard app.activate(options: [.activateAllWindows]) else { throw DesktopError(message: "无法激活目标应用") }
            return ["activated": true, "launched": false, "application": appIdentity(app)]
        }
        guard bundle != "com.tencent.xinWeChat", request["requireRunning"] as? Bool != true else {
            throw DesktopError(message: "目标应用未运行，禁止自动启动或重新登录微信")
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw DesktopError(message: "找不到目标应用") }
        let launchBegan = Date().timeIntervalSince1970
        let semaphore = DispatchSemaphore(value: 0); var launched: NSRunningApplication?; var launchError: Error?
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in launched = app; launchError = error; semaphore.signal() }
        guard waitWithRunLoop(semaphore, seconds: 7), let app = launched, launchError == nil else { throw DesktopError(message: "目标应用启动或激活失败") }
        return ["activated": true, "launched": (app.launchDate?.timeIntervalSince1970 ?? 0) >= launchBegan, "application": appIdentity(app)]
    case "click", "move", "scroll", "key", "type", "pasteFile":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        _ = try validateActionContext(request)
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw DesktopError(message: "缺少辅助功能/输入监控权限；请显式调用 requestPermission 后在系统设置中允许") }
        let (windowId, rect) = try targetWindow(request)
        if op == "pasteFile" {
            guard let file = request["filePath"] as? String, let expectedHash = request["sha256"] as? String,
                  file.hasPrefix("/"), expectedHash.count == 64 else { throw DesktopError(message: "附件路径或指纹无效") }
            let url = URL(fileURLWithPath: file), values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 20 * 1024 * 1024 else { throw DesktopError(message: "附件须为20MB以内普通文件") }
            let data = try Data(contentsOf: url), actualHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard actualHash == expectedHash else { throw DesktopError(message: "附件内容已改变，停止粘贴") }
            _ = try validateActionContext(request)
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.writeObjects([url as NSURL]) else { throw DesktopError(message: "文件剪贴板准备失败") }
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: down) else { throw DesktopError(message: "无法模拟文件粘贴") }
                event.flags = .maskCommand; event.post(tap: .cghidEventTap)
            }
            return ["performed": true, "windowId": windowId, "sha256": actualHash]
        }
        if op == "click" || op == "move" {
            let p = try point(request, in: rect)
            if op == "move" { try postMouse(.mouseMoved, p) }
            else {
                let button = request["button"] as? String ?? "left"
                guard ["left", "right"].contains(button) else { throw DesktopError(message: "鼠标按钮无效") }
                try validateWorkBuddySubmission(request, submissionExpectation)
                if button == "right" { try postMouse(.rightMouseDown, p, .right); try postMouse(.rightMouseUp, p, .right) }
                else { try postMouse(.leftMouseDown, p); try postMouse(.leftMouseUp, p) }
            }
            return ["performed": true, "windowId": windowId, "point": ["x": p.x, "y": p.y]]
        }
        if op == "scroll" {
            let p = try point(request, in: rect)
            let dx = number(request["deltaX"]) ?? 0, dy = number(request["deltaY"]) ?? 0
            guard abs(dx) <= 2000, abs(dy) <= 2000, let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { throw DesktopError(message: "滚动参数无效") }
            event.location = p
            event.post(tap: .cghidEventTap); return ["performed": true, "windowId": windowId]
        }
        if op == "key" {
            guard let name = request["key"] as? String, let code = keyCode(name) else { throw DesktopError(message: "不支持的按键") }
            let flags = try modifiers(request["modifiers"])
            try validateWorkBuddySubmission(request, submissionExpectation)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { throw DesktopError(message: "无法创建键盘事件") }
                event.flags = flags; event.post(tap: .cghidEventTap)
            }
            return ["performed": true, "windowId": windowId]
        }
        guard let value = request["text"] as? String, !value.isEmpty, value.utf16.count <= 4096 else { throw DesktopError(message: "文本长度须为 1 至 4096 个 UTF-16 单元") }
        let plan = try makeInputPlan(value, lineBreak: request["lineBreak"])
        for item in plan {
            let (currentId, _) = try validateActionContext(request)
            guard currentId == windowId else { throw DesktopError(message: "目标窗口已变化，停止继续输入") }
            switch item {
            case .text(let units): try postUnicodeText(units)
            case .softLineBreak: try postShiftReturn()
            }
        }
        return ["performed": true, "windowId": windowId, "utf16Units": value.utf16.count,
                "textChunks": plan.filter { if case .text = $0 { return true }; return false }.count,
                "softLineBreaks": plan.filter { $0 == .softLineBreak }.count]
    default: throw DesktopError(message: "不支持的操作")
    }
}

func runNativeSelfTest() -> Never {
    do {
        let capitalizedRect = rectFrom(["X": 12.0, "Y": 34.0, "Width": 560.0, "Height": 420.0])
        guard capitalizedRect == CGRect(x: 12, y: 34, width: 560, height: 420) else {
            throw DesktopError(message: "CGWindowBounds 大写矩形字段未被识别")
        }
        let lowercaseRect = rectFrom(["x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0])
        guard lowercaseRect == CGRect(x: 1, y: 2, width: 3, height: 4) else {
            throw DesktopError(message: "小写矩形字段回归失败")
        }
        let invalidRects: [[String: Any]] = [
            ["X": 0.0, "Y": 0.0, "Width": 0.0, "Height": 10.0],
            ["X": 0.0, "Y": 0.0, "Width": 10.0, "Height": -1.0],
            ["X": Double.nan, "Y": 0.0, "Width": 10.0, "Height": 10.0],
            ["X": 0.0, "Y": 0.0, "Height": 10.0],
            ["X": 0.0, "Y": 0.0, "Width": 100_001.0, "Height": 10.0],
        ]
        guard invalidRects.allSatisfy({ rectFrom($0) == nil }) else { throw DesktopError(message: "非法矩形被接受") }

        guard let captureSize = capturePixelSize(rect: CGRect(x: 0, y: 0, width: 560, height: 420), pointPixelScale: 1.5),
              captureSize.width == 840, captureSize.height == 630 else {
            throw DesktopError(message: "窗口像素尺寸未按 pointPixelScale 计算")
        }
        guard capturePixelSize(rect: CGRect(x: 0, y: 0, width: 560, height: 420), pointPixelScale: .nan) == nil else {
            throw DesktopError(message: "无效 pointPixelScale 被接受")
        }
        let visualRequest: [String: Any] = ["sampleId": "selftest", "windowId": 12,
          "regions": [["x": 0.1, "y": 0.2, "width": 0.4, "height": 0.3]]]
        let visualArgs = try visualParameters(visualRequest)
        guard visualArgs.0 == "selftest", visualArgs.1 == 12, visualArgs.2.count == 1,
              visualArgs.3 == false, visualArgs.4 == 18, visualArgs.5 == 0.001, visualArgs.6 == nil else {
            throw DesktopError(message: "视觉采样参数默认值回归失败")
        }
        let validROI = try normalizedVisualRegions([["x": 0.75, "y": 0.75, "width": 0.25, "height": 0.25]])
        guard validROI.count == 1 else { throw DesktopError(message: "合法边界 ROI 被拒绝") }
        let tunedROIs = try normalizedVisualRegions([
          ["x": 0.065, "y": 0.08, "width": 0.30, "height": 0.89, "minChangedPixels": 3, "minChangedRatio": 0],
          ["x": 0.32, "y": 0.02, "width": 0.66, "height": 0.84],
        ], defaultMinChangedRatio: 0.0015)
        guard tunedROIs[0].minChangedPixels == 3, tunedROIs[0].minChangedRatio == 0,
              tunedROIs[1].minChangedPixels == 0, tunedROIs[1].minChangedRatio == 0.0015 else {
            throw DesktopError(message: "按 ROI 配置变化门槛失败")
        }
        do {
            _ = try normalizedVisualRegions([["x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2,
              "minChangedPixels": 1.5, "minChangedRatio": 0]])
            throw DesktopError(message: "非法 ROI 变化门槛被接受")
        } catch let error as DesktopError where error.message == "非法 ROI 变化门槛被接受" { throw error }
        catch { /* Fractional absolute pixel thresholds must be rejected. */ }
        for invalid in [
          [["x": -0.01, "y": 0.1, "width": 0.2, "height": 0.2]],
          [["x": 0.9, "y": 0.1, "width": 0.2, "height": 0.2]],
          [["x": 0.1, "y": 0.1, "width": 0.0, "height": 0.2]],
          (0..<5).map { _ in ["x": 0.1, "y": 0.1, "width": 0.2, "height": 0.2] },
        ] {
            do { _ = try normalizedVisualRegions(invalid); throw DesktopError(message: "错误接纳视觉 ROI") }
            catch let error as DesktopError where error.message == "错误接纳视觉 ROI" { throw error }
            catch { /* Invalid region is rejected before capture. */ }
        }
        let basePixels = VisualRegionFrame(width: 2, height: 1, rgba: [100, 100, 100, 255, 50, 60, 70, 255])
        let changedPixels = VisualRegionFrame(width: 2, height: 1, rgba: [120, 100, 100, 255, 50, 60, 70, 255])
        let comparison = compareVisualRegion(basePixels, changedPixels, threshold: 18)
        let suppressed = compareVisualRegion(basePixels, changedPixels, threshold: 20)
        let dimensionMismatch = compareVisualRegion(basePixels,
          VisualRegionFrame(width: 1, height: 2, rgba: [100, 100, 100, 255, 50, 60, 70, 255]), threshold: 18)
        guard comparison.ratio == 0.5, comparison.changedPixels == 1, comparison.totalPixels == 2,
              suppressed.ratio == 0, dimensionMismatch.ratio == 1, dimensionMismatch.totalPixels == 0,
              comparison.ratio >= 0.4, !(comparison.ratio >= 0.6),
              comparison.changedPixels > 0 && comparison.ratio >= 0,
              !(suppressed.changedPixels > 0 && suppressed.ratio >= 0),
              shouldIncludeVisualImage(changed: false, reset: false, hasBaseline: true, includeImage: true) == false,
              shouldIncludeVisualImage(changed: false, reset: false, hasBaseline: false, includeImage: true),
              shouldIncludeVisualImage(changed: false, reset: false, geometryChanged: true, hasBaseline: true, includeImage: true),
              shouldIncludeVisualImage(changed: true, reset: false, includeImage: true),
              shouldIncludeVisualImage(changed: false, reset: true, includeImage: true),
              !shouldIncludeVisualImage(changed: true, reset: false, includeImage: false) else {
            throw DesktopError(message: "像素变化阈值、比例或 PNG 输出门控失败")
        }

        // Synthetic regression for the configured sidebar crop: the integral
        // 433x1602 crop of a 1440x1800 capture is stretched into 320x320.
        // This never captures the screen.
        func syntheticSidebarImage(badgeSize: Int, shiftX: Int = 0, red: UInt8 = 255, green: UInt8 = 0, blue: UInt8 = 0) throws -> CGImage {
            let width = 433, height = 1602
            var rgba = [UInt8](repeating: 0, count: width * height * 4)
            for pixel in 0..<(width * height) {
                let offset = pixel * 4
                rgba[offset] = 100; rgba[offset + 1] = 100; rgba[offset + 2] = 100; rgba[offset + 3] = 255
            }
            if badgeSize > 0 {
                let left = 60 + shiftX, top = 240
                for y in top..<top + badgeSize {
                    for x in left..<left + badgeSize {
                        let offset = (y * width + x) * 4
                        rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue
                    }
                }
            }
            guard let provider = CGDataProvider(data: Data(rgba) as CFData),
                  let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
                throw DesktopError(message: "合成徽标采样图创建失败")
            }
            return image
        }
        let syntheticROI = VisualROI(x: 0, y: 0, width: 1, height: 1, minChangedPixels: 3, minChangedRatio: 0)
        let syntheticBaseline = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: 0), roi: syntheticROI)
        let syntheticCounts = try [5, 8, 12].map { size -> Int in
            let sample = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: size), roi: syntheticROI)
            let count = compareVisualRegion(syntheticBaseline, sample, threshold: 20).changedPixels
            guard count >= 3, count < 154 else { throw DesktopError(message: "小型侧边栏徽标门槛回归失败") }
            return count
        }
        let badge = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: 5), roi: syntheticROI)
        let badgeMask = visualChangedMask(syntheticBaseline, badge, threshold: 20)
        let sameBadge = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: 5), roi: syntheticROI)
        let movedBadge = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: 5, shiftX: 80), roi: syntheticROI)
        let lowNoise = try downsampleVisualRegion(syntheticSidebarImage(badgeSize: 5, red: 120, green: 100, blue: 100), roi: syntheticROI)
        let stableOverlap = visualMaskOverlap(badgeMask, visualChangedMask(syntheticBaseline, sameBadge, threshold: 20))
        guard stableOverlap >= syntheticROI.minChangedPixels,
              visualMaskOverlap(badgeMask, visualChangedMask(syntheticBaseline, syntheticBaseline, threshold: 20)) == 0,
              visualMaskOverlap(badgeMask, visualChangedMask(syntheticBaseline, movedBadge, threshold: 20)) < syntheticROI.minChangedPixels,
              compareVisualRegion(syntheticBaseline, lowNoise, threshold: 20).changedPixels == 0,
              compareVisualRegion(syntheticBaseline, syntheticBaseline, threshold: 20).changedPixels == 0 else {
            throw DesktopError(message: "侧边栏徽标连续帧空间重叠/消失/移动/低幅噪声回归失败")
        }
        visualSampleStates.removeAll(); visualSampleLRU.removeAll()
        let fakeFrame = VisualFrame(sampleId: "a", windowId: 12, pid: 34, bundleId: "fixture",
          desktopRect: CGRect(x: 1, y: 2, width: 20, height: 10), width: 40, height: 20,
          regions: [VisualROI(x: 0, y: 0, width: 1, height: 1, minChangedPixels: 0, minChangedRatio: 0.001)], pixels: [basePixels])
        ensureVisualSampleState("a")
        visualSampleStates["a"]?.latest = fakeFrame
        guard (try visualCommit(["sampleId": "a"]))["committed"] as? Bool == true,
              visualSampleStates["a"]?.baseline?.width == 40 else {
            throw DesktopError(message: "visualCommit 未将上次样本设为基线")
        }
        resetVisualBaseline("a")
        guard visualSampleStates["a"]?.baseline == nil, visualSampleStates["a"]?.latest?.width == 40 else {
            throw DesktopError(message: "reset 未清除基线或错误丢弃当前样本")
        }
        for index in 0..<visualSampleCapacity { ensureVisualSampleState("capacity-\(index)") }
        guard visualSampleStates.count == visualSampleCapacity, visualSampleStates["a"] == nil,
              visualSampleLRU.count == visualSampleCapacity,
              (try visualForget(["sampleId": "capacity-7"]))["forgotten"] as? Bool == true,
              visualSampleStates.count == visualSampleCapacity - 1 else {
            throw DesktopError(message: "视觉采样缓存容量或 forget 释放策略失败")
        }
        visualSampleStates.removeAll(); visualSampleLRU.removeAll()
        let idle = inputIdle()
        guard (idle["hidIdleMs"] is NSNull || (idle["hidIdleMs"] as? Double)?.isFinite == true),
              (idle["combinedIdleMs"] is NSNull || (idle["combinedIdleMs"] as? Double)?.isFinite == true) else {
            throw DesktopError(message: "Core Graphics 输入空闲采样格式错误")
        }
        guard workBuddyBundleAllowed("com.tencent.workbuddy.mac"),
              !workBuddyBundleAllowed("com.tencent.wework"),
              !workBuddyBundleAllowed("com.tencent.xinWeChat"),
              workBuddyModelAllowed("deepseek-v4.1-flash", selectedModel: "Deepseek-V4.1-Flash"),
              !workBuddyModelAllowed("deepseek-v4.1-pro", selectedModel: "Deepseek-V4.1-Pro"),
              !workBuddyControlsUnique(editors: 0, combos: 1, sendButtons: 1, scanComplete: true),
              !workBuddyControlsUnique(editors: 2, combos: 1, sendButtons: 1, scanComplete: true),
              !workBuddyControlsUnique(editors: 1, combos: 2, sendButtons: 1, scanComplete: true),
              !workBuddyControlsUnique(editors: 1, combos: 1, sendButtons: 1, scanComplete: false),
              workBuddyCanDescend(depth: 25, childCount: 1),
              workBuddyCanDescend(depth: 47, childCount: 1),
              !workBuddyCanDescend(depth: 48, childCount: 1),
              !workBuddyCanDescend(depth: 10, childCount: 0),
              workBuddyHomeReady(title: "WorkBuddy, 我帮你"),
              workBuddyHeadingHomeReady(value: "", title: "WorkBuddy， 我帮你", description: nil),
              workBuddyHeadingHomeReady(value: nil, title: nil, description: " WorkBuddy,　我帮你 "),
              !workBuddyHeadingHomeReady(value: "WorkBuddy, 我帮你 later", title: nil, description: nil),
              !workBuddyHomeReady(title: "Other window"),
              workBuddySendPoint(buttonRect: CGRect(x: 10, y: 10, width: 5, height: 5), windowRect: CGRect(x: 0, y: 0, width: 20, height: 20)) == CGPoint(x: 12.5, y: 12.5),
              workBuddySendPoint(buttonRect: nil, windowRect: CGRect(x: 0, y: 0, width: 20, height: 20)) == nil,
              workBuddySendPoint(buttonRect: CGRect(x: 19, y: 10, width: 5, height: 5), windowRect: CGRect(x: 0, y: 0, width: 20, height: 20)) == nil,
              workBuddySendPoint(buttonRect: CGRect(x: 10, y: 10, width: 0, height: 5), windowRect: CGRect(x: 0, y: 0, width: 20, height: 20)) == nil,
              rectIntersects(CGRect(x: 15, y: 15, width: 10, height: 10), CGRect(x: 0, y: 0, width: 20, height: 20)),
              !rectIntersects(CGRect(x: 30, y: 30, width: 10, height: 10), CGRect(x: 0, y: 0, width: 20, height: 20)),
              workBuddyMarkerAllowed("[workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]"),
              !workBuddyMarkerAllowed("[workbunny:not-a-uuid]"),
              workBuddyTargetReady(mode: "home", homeReady: true, conversationMarkerPresent: false),
              !workBuddyTargetReady(mode: "conversation", homeReady: true, conversationMarkerPresent: false),
              workBuddyTargetReady(mode: "conversation", homeReady: false, conversationMarkerPresent: true),
              !workBuddyTargetReady(mode: "arbitrary", homeReady: true, conversationMarkerPresent: true) else {
            throw DesktopError(message: "WorkBuddy bundle/model/control/home guard 失败")
        }
        // Responsive composer fixtures: collapsed/expanded sidebar, resized
        // and displaced windows. The neighboring access popup is not a route.
        for (width, inset) in [(961.0, 81.0), (961.0, 290.0), (1440.0, 310.0), (640.0, 24.0)] {
            let window = CGRect(x: -500, y: 80, width: width, height: 1280)
            let editor = CGRect(x: window.minX + inset, y: 600, width: width - inset - 60, height: 110)
            let popup = CGRect(x: editor.minX + 3, y: editor.maxY + 12, width: 150, height: 28)
            guard workBuddyWorkspacePickerRect(popup, editor: editor, window: window),
                  !workBuddyWorkspacePickerRect(popup.offsetBy(dx: 170, dy: 0), editor: editor, window: window),
                  !workBuddyWorkspacePickerRect(popup.offsetBy(dx: 0, dy: -300), editor: editor, window: window),
                  !workBuddyWorkspacePickerRect(popup.offsetBy(dx: 0, dy: 300), editor: editor, window: window),
                  !workBuddyWorkspacePickerRect(popup.offsetBy(dx: -1000, dy: 0), editor: editor, window: window) else {
                throw DesktopError(message: "WorkBuddy 响应式工作空间选择器定位失败")
            }
        }
        guard case .write = workBuddyDraftPlan(current: "", requested: "task text"),
              case .write = workBuddyDraftPlan(current: "\u{FEFF}", requested: "task text"),
              case .write = workBuddyDraftPlan(current: workBuddyRTEEmptyValue, requested: "task text", sendButtonCount: 1, sendEnabled: false),
              case .alreadyFilled = workBuddyDraftPlan(current: "task text", requested: "task text"),
              case .alreadyFilled = workBuddyDraftPlan(current: "\u{FEFF}task text", requested: "task text"),
              case .reject = workBuddyDraftPlan(current: "different nonempty draft", requested: "task text"),
              case .reject = workBuddyDraftPlan(current: "\u{FEFF}task text ", requested: "task text"),
              case .reject = workBuddyDraftPlan(current: workBuddyRTEEmptyValue, requested: "task text", sendButtonCount: 1, sendEnabled: true),
              case .reject = workBuddyDraftPlan(current: workBuddyRTEEmptyValue, requested: "task text", sendButtonCount: 0, sendEnabled: false),
              case .reject = workBuddyDraftPlan(current: workBuddyRTEEmptyValue + " ", requested: "task text", sendButtonCount: 1, sendEnabled: false),
              workBuddyDraftIsEmpty(""), workBuddyDraftIsEmpty("\u{FEFF}"),
              workBuddyDraftIsEmpty(workBuddyRTEEmptyValue, sendButtonCount: 1, sendEnabled: false),
              !workBuddyDraftIsEmpty(workBuddyRTEEmptyValue, sendButtonCount: 1, sendEnabled: true),
              !workBuddyDraftIsEmpty(workBuddyRTEEmptyValue + " ", sendButtonCount: 1, sendEnabled: false),
              !workBuddyDraftIsEmpty("\u{FEFF}\u{FEFF}"), !workBuddyDraftIsEmpty(" \n"),
              case .reject = workBuddyDraftPlan(current: nil, requested: "task text") else {
            throw DesktopError(message: "WorkBuddy 草稿填充幂等策略失败")
        }
        // Offline controlled-editor fixtures: focus can reveal a different
        // draft even when the pre-focus AX snapshot was empty or identical.
        let focusedRequest = "current fixture request"
        let restoredDraft = "previous fixture draft [workbunny:bcf0b2af-d420-4fb4-8fa3-98effc9246c9]"
        guard case .write = workBuddyDraftPlan(current: "", requested: focusedRequest),
              case .reject = workBuddyDraftPlan(current: restoredDraft, requested: focusedRequest),
              case .reject = workBuddyDraftPlan(current: nil, requested: focusedRequest),
              case .alreadyFilled = workBuddyDraftPlan(current: focusedRequest, requested: focusedRequest, sendButtonCount: 1, sendEnabled: false),
              case .reject = workBuddyDraftPlan(current: focusedRequest + restoredDraft, requested: focusedRequest),
              !workBuddyReadbackFlags(actual: focusedRequest + restoredDraft, expected: focusedRequest).matches else {
            throw DesktopError(message: "WorkBuddy 焦点后草稿冲突与禁止同文重写策略失败")
        }
        let submissionFixture: [String: Any] = ["op": "click", "expected": ["bundleId": workBuddyBundleID],
            "expectedSubmissionText": focusedRequest, "expectedSubmissionMode": "home"]
        guard try workBuddySubmissionExpectation(["op": "click"]) == nil,
              try workBuddySubmissionExpectation(submissionFixture)?.text == focusedRequest,
              case .ready = workBuddySubmissionDraftState(scanComplete: true, editorCount: 1, targetReady: true,
                  scannedDraft: focusedRequest, currentDraft: "\u{FEFF}" + focusedRequest, expected: focusedRequest),
              case .conflict = workBuddySubmissionDraftState(scanComplete: true, editorCount: 1, targetReady: true,
                  scannedDraft: focusedRequest, currentDraft: focusedRequest + restoredDraft, expected: focusedRequest),
              case .unverified = workBuddySubmissionDraftState(scanComplete: false, editorCount: 1, targetReady: true,
                  scannedDraft: focusedRequest, currentDraft: focusedRequest, expected: focusedRequest),
              case .unverified = workBuddySubmissionDraftState(scanComplete: true, editorCount: 1, targetReady: true,
                  scannedDraft: focusedRequest, currentDraft: nil, expected: focusedRequest) else {
            throw DesktopError(message: "WorkBuddy 提交前全文核对策略失败")
        }
        for patch: [String: Any] in [["op": "type"], ["expected": ["bundleId": "com.tencent.xinWeChat"]],
            ["expectedSubmissionText": ""], ["expectedSubmissionText": 3], ["expectedSubmissionMode": "conversation"],
            ["expectedSubmissionMarker": "[workbunny:invalid]"]] {
            do {
                _ = try workBuddySubmissionExpectation(submissionFixture.merging(patch) { _, value in value })
                throw DesktopError(message: "错误接纳提交全文核对参数")
            } catch let error as DesktopError where error.code == "E_GUI_DRAFT_UNVERIFIED" && error.dispatched == false { /* Expected pure parameter rejection. */ }
        }
        let exactReadback = workBuddyReadbackFlags(actual: "line1\nline2", expected: "line1\nline2")
        let bomReadback = workBuddyReadbackFlags(actual: "\u{FEFF}task", expected: "task")
        let newlineReadback = workBuddyReadbackFlags(actual: "\u{FEFF}task\n", expected: "task")
        let whitespaceReadback = workBuddyReadbackFlags(actual: "task ", expected: "task")
        let paragraphExpected = "alpha\n\nbeta"
        let paragraphSerialized = "alpha\n\u{FEFF}\nbeta"
        let paragraphReadback = workBuddyReadbackFlags(actual: paragraphSerialized, expected: paragraphExpected)
        let multipleEmptyExpected = "a\n\n\nb"
        let multipleEmptySerialized = "a\n\u{FEFF}\n\u{FEFF}\nb"
        guard exactReadback.matches, !exactReadback.trailingNewline, !exactReadback.whitespaceOnly,
              bomReadback.matches, !bomReadback.trailingNewline, !bomReadback.whitespaceOnly,
              !newlineReadback.matches, newlineReadback.trailingNewline, newlineReadback.whitespaceOnly,
              !whitespaceReadback.matches, !whitespaceReadback.trailingNewline, whitespaceReadback.whitespaceOnly,
              paragraphReadback.matches, !paragraphReadback.trailingNewline,
              workBuddyTextMatches(paragraphSerialized, expected: paragraphExpected),
              case .alreadyFilled = workBuddyDraftPlan(current: paragraphSerialized, requested: paragraphExpected),
              workBuddyTextMatches("\u{FEFF}" + paragraphExpected, expected: paragraphExpected),
              workBuddyTextMatches(multipleEmptySerialized, expected: multipleEmptyExpected),
              !workBuddyTextMatches("alpha\u{FEFF}\n\nbeta", expected: paragraphExpected),
              !workBuddyTextMatches("alpha\nx\u{FEFF}beta", expected: "alpha\nxbeta"),
              !workBuddyTextMatches("alpha\n\u{FEFF}\u{FEFF}\nbeta", expected: paragraphExpected),
              !workBuddyTextMatches("alpha\n\u{FEFF}\nbeta ", expected: paragraphExpected),
              !workBuddyTextMatches("alpha\n\u{FEFF}\nbxta", expected: paragraphExpected),
              !workBuddyTextMatches(paragraphSerialized + "\n", expected: paragraphExpected),
              workBuddyTextMatches("alpha\n\u{FEFF}\nbeta\n\u{FEFF}\ngamma", expected: "alpha\n\nbeta\n\ngamma") else {
            throw DesktopError(message: "WorkBuddy 读回规范化/差异标志失败")
        }
        guard workBuddyTextMatches("alpha\u{FEFF}\n\u{FEFF}beta\u{FEFF}\n\u{FEFF}\u{FEFF}\n\u{FEFF}gamma", expected: "alpha\nbeta\n\ngamma"),
              !workBuddyTextMatches("alpha\u{FEFF}x\nbeta", expected: "alphax\nbeta") else {
            throw DesktopError(message: "WorkBuddy 软换行边界哨兵匹配失败")
        }
        let atLimit = String(repeating: "😀", count: workBuddyTextUTF16Limit / 2)
        guard workBuddyTextWithinLimit(atLimit), atLimit.utf16.count == workBuddyTextUTF16Limit,
              !workBuddyTextWithinLimit(atLimit + "a"), workBuddyTextControlsAllowed("line1\r\nline2"),
              !workBuddyTextControlsAllowed("bad\rbreak"), !workBuddyTextControlsAllowed("bad\ttab"),
              !workBuddyTextControlsAllowed("bad\u{0001}control") else {
            throw DesktopError(message: "WorkBuddy UTF-16 文本上限回归失败")
        }
        let detachedProbe = DispatchSemaphore(value: 0)
        Task.detached { detachedProbe.signal() }
        guard waitWithRunLoop(detachedProbe, seconds: 1),
              !displayCropSharingAllowed(nil), !displayCropSharingAllowed(0), displayCropSharingAllowed(1),
              displayCropPixelRect(CGRect(x: -900, y: 100, width: 200, height: 150),
                  displayRect: CGRect(x: -1000, y: 0, width: 1000, height: 800), imageWidth: 2000, imageHeight: 1600) == CGRect(x: 200, y: 200, width: 400, height: 300),
              displayCropPixelRect(CGRect(x: -1100, y: 100, width: 200, height: 150),
                  displayRect: CGRect(x: -1000, y: 0, width: 1000, height: 800), imageWidth: 2000, imageHeight: 1600) == nil else {
            throw DesktopError(message: "截图独立任务或多显示器裁切回归失败")
        }
        let windowConfig = makeCaptureConfiguration(width: captureSize.width, height: captureSize.height, fitWindow: true)
        if #available(macOS 14.0, *) {
        guard windowConfig.scalesToFit, windowConfig.preservesAspectRatio,
              windowConfig.ignoreShadowsSingleWindow, windowConfig.ignoreShadowsDisplay, !windowConfig.showsCursor else {
            throw DesktopError(message: "窗口截图配置未启用适配、等比缩放及无阴影/光标")
        }
        }

        let multiline = try makeInputPlan("A\r\nB\nC", lineBreak: "shiftEnter")
        let expected: [DesktopInputEvent] = [.text([65]), .softLineBreak, .text([66]), .softLineBreak, .text([67])]
        guard multiline == expected else { throw DesktopError(message: "CRLF/LF 软换行计划不匹配") }
        for value in ["a\rb", "a\tb", "a\0b", "a\u{7f}b", "a\u{0b}b"] {
            do { _ = try makeInputPlan(value, lineBreak: "shiftEnter"); throw DesktopError(message: "错误接纳控制字符") }
            catch let error as DesktopError where error.message == "错误接纳控制字符" { throw error }
            catch { /* Expected rejection before any CGEvent creation. */ }
        }
        let boundary = String(repeating: "a", count: 19) + "😀b"
        let chunks = unicodeChunks(boundary)
        guard chunks.count == 2, chunks[0].count == 19, chunks[0] == Array(String(repeating: "a", count: 19).utf16),
              chunks[1] == Array("😀b".utf16) else { throw DesktopError(message: "Unicode chunk 拆分了 surrogate pair") }
        do { _ = try makeInputPlan("a\nb"); throw DesktopError(message: "缺失 lineBreak 时接纳了换行") }
        catch let error as DesktopError where error.message == "缺失 lineBreak 时接纳了换行" { throw error }
        catch { /* Expected rejection of implicit newline. */ }
        writeJSON(["ok": true, "selfTest": "native", "rectCases": ["CGWindowBounds", "lowercase"],
                   "capturePixelSize": [captureSize.width, captureSize.height], "windowFit": true,
                   "visualSample": true, "visualCapacity": visualSampleCapacity, "inputIdleReadOnly": true,
                   "syntheticSidebarBadgePixels": syntheticCounts, "syntheticStableOverlap": stableOverlap,
                   "workBuddyGuards": true, "workBuddyConversationGuard": true, "workBuddyReadbackGuards": true, "workBuddySerializedMatch": true,
                   "workBuddyPostFocusDraftGuards": true,
                   "workBuddySubmissionDraftGuards": true,
                   "workBuddyTextUTF16Limit": workBuddyTextUTF16Limit,
                   "invalidRectsRejected": invalidRects.count,
                   "multilineEvents": ["text:A", "shiftEnter", "text:B", "shiftEnter", "text:C"],
                   "surrogateChunkSizes": chunks.map(\.count)])
        exit(0)
    } catch {
        writeJSON(["ok": false, "selfTest": "inputPlan", "error": error.localizedDescription])
        exit(1)
    }
}

if CommandLine.arguments.contains("--self-test-pointer-approval") {
    let window = CGRect(x: -100, y: 20, width: 1000, height: 800), button = CGRect(x: 700, y: 700, width: 40, height: 30)
    let approved: [String: Any] = ["approvedPointer": ["point": ["x": 720, "y": 715], "rect": rectObject(button)]]
    do {
        guard try approvedWorkBuddySendPoint(approved, buttonRect: button, windowRect: window) == CGPoint(x: 720, y: 715) else { throw DesktopError(message: "approved point mismatch") }
        let cases: [([String: Any], CGRect?)] = [([:], button), (approved, nil), (approved, button.offsetBy(dx: 0.5, dy: 0)),
            (["approvedPointer": ["point": ["x": 721, "y": 715], "rect": rectObject(button)]], button),
            (["approvedPointer": ["point": ["x": 720, "y": 715], "rect": ["x": 700, "y": 700, "width": 0, "height": 30]]], button)]
        for (request, rect) in cases {
            do { _ = try approvedWorkBuddySendPoint(request, buttonRect: rect, windowRect: window); throw DesktopError(message: "accepted pointer drift") }
            catch let error as DesktopError where error.code == "E_GUI_POINTER_CHANGED" && error.dispatched == false { }
        }
        writeJSON(["ok": true, "selfTest": "pointer-approval", "rejectedCases": cases.count, "noInputDispatched": true]);exit(0)
    } catch { writeJSON(["ok": false, "selfTest": "pointer-approval"]);exit(1) }
}
if CommandLine.arguments.contains("--self-test-native") || CommandLine.arguments.contains("--self-test-input-plan") ||
   CommandLine.arguments.contains("--self-test-workbuddy") || CommandLine.arguments.contains("--self-test-visual") { runNativeSelfTest() }

if CommandLine.arguments.contains("--self-test-display-lease") {
    do { try ensureDisplayOwnership(directory: ProcessInfo.processInfo.environment["WORKBUNNY_TEST_DISPLAY_LEASE_DIR"] ?? NSTemporaryDirectory()); writeJSON(["ok": true, "held": true]); _ = readLine(); exit(0) }
    catch { writeJSON(["ok": false, "code": "E_CAPTURE_BUSY"]); exit(1) }
}

func handleLineInPool(_ line: String) {
    guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        writeJSON(["id": NSNull(), "ok": false, "error": "无效 JSON 请求"]); return
    }
    let id = request["id"] ?? NSNull()
    do { writeJSON(["id": id, "ok": true, "result": try perform(request)]) }
    catch is CaptureBusyError { writeJSON(["id": id, "ok": false, "code": "E_CAPTURE_BUSY", "error": "另一个截图进程正在使用显示连接，稍后继续"]) }
    catch let e as CaptureUnavailableError { writeJSON(["id": id, "ok": false, "code": "captureUnavailable", "error": e.message]) }
    catch let e as DesktopError {
        var response: [String: Any] = ["id": id, "ok": false, "error": e.message]
        if let code = e.code { response["code"] = code }
        if let dispatched = e.dispatched { response["dispatched"] = dispatched }
        if let diagnostic = e.diagnostic { response["diagnostic"] = diagnostic }
        writeJSON(response)
    }
    catch { writeJSON(["id": id, "ok": false, "error": error.localizedDescription]) }
}

// Release temporary display/PNG/Vision objects after each request during long watches.
func handleLine(_ line: String) { autoreleasepool { handleLineInPool(line) } }

// Keep AppKit's main run loop moving so NSWorkspace frontmost-app state stays
// current while stdin is idle; otherwise readLine() can leave it cached stale.
let inputStateLock = NSLock()
var inputFinished = false
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() { DispatchQueue.main.async { handleLine(line) } }
    DispatchQueue.main.async {
        inputStateLock.lock(); inputFinished = true; inputStateLock.unlock()
    }
}
while true {
    inputStateLock.lock(); let finished = inputFinished; inputStateLock.unlock()
    if finished { break }
    _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
}
