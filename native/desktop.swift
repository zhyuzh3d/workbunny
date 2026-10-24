// Minimal, bounded desktop control bridge for workbunny.
// Protocol: one JSON object per stdin line; one {id,ok,...} JSON per stdout line.
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ScreenCaptureKit
import Vision

struct DesktopError: LocalizedError { let message: String; var errorDescription: String? { message } }
let outputLock = NSLock()
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
        // Window titles are intentionally omitted; callers only need IDs and geometry.
        return ["windowId": id, "pid": pid, "layer": layer, "rect": rectObject(rect)]
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
func captureImage(_ windowId: UInt32?) async throws -> (CGImage, CGRect) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let filter: SCContentFilter
    let rect: CGRect
    let width: Int
    let height: Int
    if let windowId {
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else { throw DesktopError(message: "目标窗口已关闭或不可见") }
        guard let row = windowEntries().first(where: { ($0["windowId"] as? UInt32) == windowId }),
              let cgRect = rectFrom(row["rect"]) else { throw DesktopError(message: "目标窗口几何信息不可用") }
        filter = SCContentFilter(desktopIndependentWindow: window)
        // Use the same CGRect source exposed by frontmost.windows so callers can
        // map desktop points to the captured image without a second origin system.
        rect = cgRect
        width = max(1, Int(rect.width * 2)); height = max(1, Int(rect.height * 2))
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw DesktopError(message: "找不到可用显示器")
        }
        filter = SCContentFilter(display: display, excludingWindows: [])
        rect = CGDisplayBounds(display.displayID)
        width = display.width; height = display.height
    }
    let config = SCStreamConfiguration()
    config.width = width; config.height = height; config.capturesAudio = false; config.showsCursor = false
    config.ignoreShadowsSingleWindow = true; config.ignoreShadowsDisplay = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    return (image, rect)
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
    let vision = VNRecognizeTextRequest()
    vision.recognitionLevel = .accurate
    vision.recognitionLanguages = ["zh-Hans", "en-US"]
    vision.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([vision]) }
    catch { throw DesktopError(message: "图像文字识别失败：\(error.localizedDescription)") }
    let observations = vision.results ?? []
    let texts: [[String: Any]] = observations.compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        let x = min(1, max(0, box.minX)), y = min(1, max(0, 1 - box.maxY))
        return ["text": candidate.string, "confidence": Double(candidate.confidence),
                "x": Double(x), "y": Double(y), "width": Double(box.width), "height": Double(box.height)]
    }
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
    case "recognize": return try recognizePNG(request)
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
            case .text(let units):
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { throw DesktopError(message: "无法创建文本事件") }
                    event.flags = []
                    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    event.post(tap: .cghidEventTap)
                }
            case .softLineBreak:
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down) else { throw DesktopError(message: "无法创建软换行事件") }
                    event.flags = .maskShift
                    event.post(tap: .cghidEventTap)
                }
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
                   "invalidRectsRejected": invalidRects.count,
                   "multilineEvents": ["text:A", "shiftEnter", "text:B", "shiftEnter", "text:C"],
                   "surrogateChunkSizes": chunks.map(\.count)])
        exit(0)
    } catch {
        writeJSON(["ok": false, "selfTest": "inputPlan", "error": error.localizedDescription])
        exit(1)
    }
}

if CommandLine.arguments.contains("--self-test-native") || CommandLine.arguments.contains("--self-test-input-plan") { runNativeSelfTest() }

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
