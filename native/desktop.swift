// Minimal, bounded desktop control bridge for workbunny.
// Protocol: one JSON object per stdin line; one {id,ok,...} JSON per stdout line.
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit
import CoreImage
import Vision

struct DesktopError: LocalizedError { let message: String; var errorDescription: String? { message } }
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
        return ["windowId": id, "pid": pid, "bundleId": bundleId, "layer": layer, "rect": rectObject(rect)]
    }
}
func appIdentity(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app else { return ["pid": 0, "bundleId": "", "name": ""] }
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""]
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
func postUnicodeText(_ units: [UInt16]) throws {
    guard !units.isEmpty else { return }
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw DesktopError(message: "无法创建文本事件") }
        event.flags = []
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        event.post(tap: .cghidEventTap)
    }
}
func postShiftReturn() throws {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down) else { throw DesktopError(message: "无法创建软换行事件") }
        event.flags = .maskShift
        event.post(tap: .cghidEventTap)
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
let workBuddyUIModel = "Deepseek-V4.1-Flash"
let workBuddyRTEEmptyValue = "\u{FEFF}\n今天帮你做些什么？@ 添加上下文，/调用技能与指令"
enum WorkBuddyDraftPlan { case write, alreadyFilled, reject }
func workBuddyBundleAllowed(_ bundle: String?) -> Bool { bundle == workBuddyBundleID }
func workBuddyMarkerAllowed(_ marker: String?) -> Bool {
    guard let marker, marker.hasPrefix("[workbunny:"), marker.hasSuffix("]") else { return false }
    let value = String(marker.dropFirst("[workbunny:".count).dropLast())
    return UUID(uuidString: value) != nil && marker.utf16.count <= 64
}
func workBuddyModelAllowed(_ requestModel: String?, selectedModel: String?) -> Bool {
    requestModel == "deepseek-v4.1-flash" && selectedModel == workBuddyUIModel
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
func validateWorkBuddyContext(_ request: [String: Any]) throws -> WorkBuddyContext {
    guard let expected = request["expected"] as? [String: Any],
          let bundle = expected["bundleId"] as? String, workBuddyBundleAllowed(bundle),
          let pidValue = expected["pid"] as? Int, pidValue > 0 else {
        throw DesktopError(message: "WorkBuddy AX 操作仅允许目标应用 com.tencent.workbuddy.mac")
    }
    guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
    guard let front = currentFrontmost(), workBuddyBundleAllowed(front.bundleIdentifier),
          Int(front.processIdentifier) == pidValue else { throw DesktopError(message: "当前前台不是预期 WorkBuddy 窗口") }
    let (windowID, rect) = try validateActionContext(request)
    return WorkBuddyContext(pid: pid_t(pidValue), windowID: windowID, rect: rect)
}
func revalidateWorkBuddyContext(_ request: [String: Any], _ original: WorkBuddyContext) throws {
    let current = try validateWorkBuddyContext(request)
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
    let context = try validateWorkBuddyContext(request)
    guard AXIsProcessTrusted() else { throw DesktopError(message: "缺少辅助功能权限") }
    // The exact bundle/PID and matching visible CG window are checked before creating any AX element.
    let app = AXUIElementCreateApplication(context.pid)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let window = workBuddyAXWindow(app: app, targetRect: context.rect) else {
        try revalidateWorkBuddyContext(request, context)
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
    try revalidateWorkBuddyContext(request, context)
    let available = workBuddyControlsUnique(editors: controls.editors.count, combos: controls.combos.count,
                                             sendButtons: controls.sendButtons.count, scanComplete: controls.scanComplete)
    return (context, controls, available)
}
func workBuddyInspect(_ request: [String: Any]) throws -> [String: Any] {
    let mode = request["mode"] as? String ?? "home"
    let (_, controls, available) = try workBuddyControls(request)
    var draftMatchesRequest = false
    if let expected = request["text"] {
        guard let text = expected as? String, workBuddyTextWithinLimit(text), workBuddyTextControlsAllowed(text) else {
            throw DesktopError(message: "WorkBuddy inspect 文本无效或超过 12000 个 UTF-16 单元")
        }
        draftMatchesRequest = available && workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent) && controls.selectedModel == workBuddyUIModel &&
            workBuddyTextMatches(controls.draft, expected: text)
    }
    return ["available": available, "editorCount": controls.editors.count,
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
    guard axAttribute(combo, kAXValueAttribute as String) as? String == workBuddyUIModel,
          workBuddyEditorFocused(controls) else { throw DesktopError(message: "WorkBuddy 模型或输入焦点已变化，停止输入") }
}
func workBuddyFill(_ request: [String: Any]) throws -> [String: Any] {
    let (text, model) = try workBuddyPayload(request)
    let mode = request["mode"] as? String ?? "home"
    let (context, controls, available) = try workBuddyControls(request)
    guard available, workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent), controls.editors.count == 1,
          workBuddyModelAllowed(model, selectedModel: controls.selectedModel), let editor = controls.editors.first else {
        throw DesktopError(message: "WorkBuddy 编辑器、首页或 Flash 模型状态未确认")
    }
    let expectedText = text
    switch workBuddyDraftPlan(current: controls.draft, requested: expectedText,
                              sendButtonCount: controls.sendButtons.count, sendEnabled: controls.sendEnabled) {
    case .alreadyFilled: return ["filled": true, "idempotent": true]
    case .reject: throw DesktopError(message: "WorkBuddy 草稿非空且与请求不同，已保留原内容")
    case .write: break
    }
    let plan = try makeInputPlan(text, lineBreak: "shiftEnter")
    guard let combo = controls.combos.first?.0,
          axAttribute(combo, kAXValueAttribute as String) as? String == workBuddyUIModel else {
        throw DesktopError(message: "WorkBuddy 模型已变化，草稿未写入")
    }
    let latestSendEnabled = (controls.sendButtons.first.map { axAttribute($0.0, kAXEnabledAttribute as String) as? NSNumber } ?? nil)?.boolValue ?? true
    switch workBuddyDraftPlan(current: axAttribute(editor, kAXValueAttribute as String) as? String, requested: expectedText,
                              sendButtonCount: controls.sendButtons.count, sendEnabled: latestSendEnabled) {
    case .alreadyFilled:
        try revalidateWorkBuddyContext(request, context)
        return ["filled": true, "idempotent": true]
    case .reject: throw DesktopError(message: "WorkBuddy 草稿已变化且非空，已保留原内容")
    case .write: break
    }
    try focusWorkBuddyEditor(request, context: context, controls: controls, editor: editor)
    do {
        for item in plan {
            try workBuddyInputStillTargeted(request, context: context, controls: controls, combo: combo)
            switch item {
            case .text(let units): try postUnicodeText(units)
            case .softLineBreak: try postShiftReturn()
            }
        }
    } catch {
        throw DesktopError(message: "WorkBuddy 输入中断，草稿可能部分更新；未自动重试或发送")
    }
    let waitDeadline = DispatchTime.now().uptimeNanoseconds + 800_000_000
    var finalReadback: String?
    repeat {
        try revalidateWorkBuddyContext(request, context)
        guard axAttribute(combo, kAXValueAttribute as String) as? String == workBuddyUIModel else {
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
    try revalidateWorkBuddyContext(request, context)
    return ["filled": true, "idempotent": false, "verified": true, "inputChunks": plan.count,
            "readbackLength": readback.actualLength, "trailingNewlineDifference": false,
            "whitespaceDifference": readback.whitespaceOnly]
}
func workBuddySend(_ request: [String: Any]) throws -> [String: Any] {
    let (text, model) = try workBuddyPayload(request)
    let mode = request["mode"] as? String ?? "home"
    let (context, controls, available) = try workBuddyControls(request)
    guard available, workBuddyTargetReady(mode: mode, homeReady: controls.homeReady, conversationMarkerPresent: controls.associationMarkerPresent), let editor = controls.editors.first,
          controls.editors.count == 1, workBuddyModelAllowed(model, selectedModel: controls.selectedModel),
          workBuddyTextMatches(controls.draft, expected: text),
          controls.sendButtons.count == 1, controls.sendEnabled else {
        throw DesktopError(message: "WorkBuddy 草稿、首页、Flash 模型或发送状态未确认")
    }
    guard let button = controls.sendButtons.first?.0, let combo = controls.combos.first?.0 else { throw DesktopError(message: "发送按钮或模型控件不可用") }
    try revalidateWorkBuddyContext(request, context)
    guard workBuddyTextMatches(axAttribute(editor, kAXValueAttribute as String) as? String, expected: text),
          axAttribute(combo, kAXValueAttribute as String) as? String == workBuddyUIModel,
          axAttribute(button, kAXEnabledAttribute as String) as? Bool == true else {
        throw DesktopError(message: "WorkBuddy 草稿或发送状态已变化")
    }
    let pressStatus = AXUIElementPerformAction(button, kAXPressAction as CFString)
    guard pressStatus == .success else { throw DesktopError(message: "WorkBuddy 发送调用结果不确定，不会重试") }
    let postContextIsValid = (try? revalidateWorkBuddyContext(request, context)) != nil
    guard postContextIsValid else { return ["pressed": true, "postContextValid": false] }
    return ["pressed": true]
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
func captureImage(_ windowId: UInt32?) async throws -> (CGImage, CGRect) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
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
    if #available(macOS 14.0, *) { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    else { image = try await LegacyScreenshot().capture(filter: filter, config: config) }
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

func capture(_ request: [String: Any]) throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw DesktopError(message: "缺少屏幕录制权限；请在系统设置 → 隐私与安全性 → 屏幕录制中允许 workbunny") }
    let windowId = uint(request["windowId"])
    let semaphore = DispatchSemaphore(value: 0)
    var captured: Result<(CGImage, CGRect), Error>!
    Task { do { captured = .success(try await captureImage(windowId)); semaphore.signal() }
           catch { captured = .failure(error); semaphore.signal() } }
    guard waitWithRunLoop(semaphore, seconds: 9) else { throw DesktopError(message: "截图请求超时") }
    let (image, desktopRect) = try captured.get()
    let data = try pngData(image)
    let scaleX = desktopRect.width > 0 ? Double(image.width) / desktopRect.width : 1
    let scaleY = desktopRect.height > 0 ? Double(image.height) / desktopRect.height : 1
    var result: [String: Any] = ["width": image.width, "height": image.height,
        "desktopRect": rectObject(desktopRect), "pixelsPerPoint": ["x": scaleX, "y": scaleY], "format": "png"]
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

func captureVisualFrame(sampleId: String, windowId: UInt32, regions: [VisualROI], expected: [String: Any]?) throws -> (VisualFrame, CGImage) {
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
    let semaphore = DispatchSemaphore(value: 0)
    var captured: Result<(CGImage, CGRect), Error>!
    Task { do { captured = .success(try await captureImage(windowId)); semaphore.signal() }
           catch { captured = .failure(error); semaphore.signal() } }
    guard waitWithRunLoop(semaphore, seconds: 9) else { throw DesktopError(message: "视觉采样截图超时") }
    let (image, capturedRect) = try captured.get()
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
    let (frame, image) = try captureVisualFrame(sampleId: id, windowId: windowId, regions: regions, expected: expected)
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
    switch op {
    case "permissions":
        return ["accessibilityTrusted": AXIsProcessTrusted(), "screenCaptureAllowed": CGPreflightScreenCaptureAccess(),
                "postEventAllowed": CGPreflightPostEventAccess(), "sessionLocked": sessionLocked()]
    case "requestPermission":
        let options = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true] as CFDictionary
        let ax = AXIsProcessTrustedWithOptions(options)
        let capture = CGRequestScreenCaptureAccess()
        let events = CGRequestPostEventAccess()
        return ["accessibilityTrusted": ax, "screenCaptureAllowed": capture, "postEventAllowed": events,
                "note": "若系統設定要求，請手動允許並重新啟動 workbunny"]
    case "frontmost": return ["application": appIdentity(currentFrontmost()), "windows": windowEntries()]
    case "inputIdle": return inputIdle()
    case "recognize": return try recognizePNG(request)
    case "visualSample": return try visualSample(request)
    case "visualCommit": return try visualCommit(request)
    case "visualForget": return try visualForget(request)
    case "workbuddyInspect": return try workBuddyInspect(request)
    case "workbuddyFill": return try workBuddyFill(request)
    case "workbuddySend": return try workBuddySend(request)
    case "capture":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        return try capture(request)
    case "activate":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        guard let bundle = request["bundleId"] as? String, !bundle.isEmpty else { throw DesktopError(message: "缺少 bundleId") }
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
            guard app.activate(options: [.activateAllWindows]) else { throw DesktopError(message: "无法激活目标应用") }
            return ["activated": true, "application": appIdentity(app)]
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw DesktopError(message: "找不到目标应用") }
        let semaphore = DispatchSemaphore(value: 0); var launched: NSRunningApplication?; var launchError: Error?
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in launched = app; launchError = error; semaphore.signal() }
        guard waitWithRunLoop(semaphore, seconds: 7), let app = launched, launchError == nil else { throw DesktopError(message: "目标应用启动或激活失败") }
        return ["activated": true, "application": appIdentity(app)]
    case "click", "move", "scroll", "key", "type":
        guard !sessionLocked() else { throw DesktopError(message: "电脑已锁屏，请解锁后重试") }
        _ = try validateActionContext(request)
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw DesktopError(message: "缺少辅助功能/输入监控权限；请显式调用 requestPermission 后在系统设置中允许") }
        let (windowId, rect) = try targetWindow(request)
        if op == "click" || op == "move" {
            let p = try point(request, in: rect)
            if op == "move" { try postMouse(.mouseMoved, p) }
            else {
                try postMouse(.leftMouseDown, p); try postMouse(.leftMouseUp, p)
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
        let atLimit = String(repeating: "😀", count: workBuddyTextUTF16Limit / 2)
        guard workBuddyTextWithinLimit(atLimit), atLimit.utf16.count == workBuddyTextUTF16Limit,
              !workBuddyTextWithinLimit(atLimit + "a"), workBuddyTextControlsAllowed("line1\r\nline2"),
              !workBuddyTextControlsAllowed("bad\rbreak"), !workBuddyTextControlsAllowed("bad\ttab"),
              !workBuddyTextControlsAllowed("bad\u{0001}control") else {
            throw DesktopError(message: "WorkBuddy UTF-16 文本上限回归失败")
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

if CommandLine.arguments.contains("--self-test-native") || CommandLine.arguments.contains("--self-test-input-plan") ||
   CommandLine.arguments.contains("--self-test-workbuddy") || CommandLine.arguments.contains("--self-test-visual") { runNativeSelfTest() }

func handleLine(_ line: String) {
    guard let data = line.data(using: .utf8), let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        writeJSON(["id": NSNull(), "ok": false, "error": "无效 JSON 请求"]); return
    }
    let id = request["id"] ?? NSNull()
    do { writeJSON(["id": id, "ok": true, "result": try perform(request)]) }
    catch let e as DesktopError { writeJSON(["id": id, "ok": false, "error": e.message]) }
    catch { writeJSON(["id": id, "ok": false, "error": error.localizedDescription]) }
}

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
