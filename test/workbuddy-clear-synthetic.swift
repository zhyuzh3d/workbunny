// Standalone, explicitly invoked test helper. Never used by product recovery.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
func die(_ s: String) -> Never { fputs(s + "\n", stderr); exit(1) }
func attribute(_ e: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil }
func elem(_ e: AXUIElement, _ n: String) -> AXUIElement? { guard let v = attribute(e,n), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }; return unsafeBitCast(v, to: AXUIElement.self) }
func axRect(_ e: AXUIElement) -> CGRect? {
    guard let p = attribute(e,kAXPositionAttribute as String), let s = attribute(e,kAXSizeAttribute as String),
          CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func same(_ a: CGRect, _ b: CGRect) -> Bool { abs(a.minX-b.minX)<1 && abs(a.minY-b.minY)<1 && abs(a.width-b.width)<1 && abs(a.height-b.height)<1 }
func match(_ raw: String?, _ expected: String) -> Bool {
    guard var raw else { return false }
    if raw == expected { return true }
    if !expected.hasPrefix("\u{FEFF}") && raw.hasPrefix("\u{FEFF}") { raw.removeFirst() }
    if raw == expected { return true }
    let a = raw.components(separatedBy: "\n"), b = expected.components(separatedBy: "\n")
    return a.count == b.count && zip(a,b).allSatisfy { $0 == $1 || ($1.isEmpty && $0 == "\u{FEFF}") }
}
guard CommandLine.arguments.count == 4, let pid = Int32(CommandLine.arguments[1]), let windowID = UInt32(CommandLine.arguments[2]),
      let text = try? String(contentsOfFile: CommandLine.arguments[3], encoding: .utf8),
      text.contains("[workbunny:69722ee1-2a7a-439b-9911-e690e8887f28]"),
      AXIsProcessTrusted(), CGPreflightPostEventAccess() else { die("清理参数、任务标记或权限无效") }
let app = AXUIElementCreateApplication(pid)
func validatedWindow() -> AXUIElement {
    guard let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier == "com.tencent.workbuddy.mac", front.processIdentifier == pid,
          let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }),
          (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          let bounds = row[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          let window = elem(app,kAXFocusedWindowAttribute as String), let actual = axRect(window), same(rect, actual) else { die("目标 WorkBuddy 焦点窗口已变化") }
    return window
}
let window = validatedWindow()
var queue: [(AXUIElement,Int)] = [(window,0)], index = 0, editors: [AXUIElement] = []
while index < queue.count {
    guard index < 2000 else { die("UI 扫描超限") }
    let (e,depth) = queue[index]; index += 1
    if (attribute(e,kAXRoleAttribute as String) as? String) == (kAXTextAreaRole as String) { editors.append(e) }
    if let children = attribute(e,kAXChildrenAttribute as String) as? [AXUIElement], !children.isEmpty {
        guard depth < 48 else { die("UI 深度超限") }; queue.append(contentsOf: children.map { ($0,depth+1) })
    }
}
guard editors.count == 1, let editor = editors.first, match(attribute(editor,kAXValueAttribute as String) as? String, text) else { die("编辑器不是唯一精确合成草稿，未清理") }
_ = AXUIElementSetAttributeValue(editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
usleep(150_000)
func verify() {
    _ = validatedWindow()
    guard let focused = elem(app,kAXFocusedUIElementAttribute as String), CFEqual(focused, editor),
          match(attribute(editor,kAXValueAttribute as String) as? String, text) else { die("焦点或精确草稿已变化，停止清理") }
}
func event(_ key: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) -> CGEvent {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: down) else { die("无法创建键盘事件") }; e.flags = flags; return e
}
let aDown = event(0,true,.maskCommand), aUp = event(0,false,.maskCommand)
let delDown = event(51,true,[]), delUp = event(51,false,[])
verify(); aDown.post(tap:.cghidEventTap); aUp.post(tap:.cghidEventTap)
verify(); delDown.post(tap:.cghidEventTap); delUp.post(tap:.cghidEventTap)
print("合成草稿清理动作已提交一次；须重新读取确认")
