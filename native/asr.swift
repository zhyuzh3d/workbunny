// workbunny 语音识别子进程 —— macOS 26 SpeechAnalyzer 版
//
// 为什么不用 SFSpeechRecognizer：它依赖系统「听写/Siri」，用户没开就报
// "Siri and Dictation are disabled"，而开 Siri 是很重的系统级动作。
// macOS 26 的 SpeechAnalyzer + SpeechTranscriber 是独立端侧管线，
// 只要该语言资产已装（本机 zh-CN 已装）就能用，不需要 Siri。
//
// 两种模式：
//   · 单次（默认）：识别一段 → final → end → 退出
//   · 常驻（--always）：一直听，静音切句，每句一条 utterance，不退出
//
// 关键设计：**一句话一个识别会话**。
//   早先用「全文按字符偏移切片」切句，遇到识别器回头改写前文就直接错位、
//   把后半句吃掉。现在每次判定一句话结束就 finalize 当前 analyzer，
//   再新建一个继续听 —— 切点永远干净。
//
// stdout 逐行 JSON：
//   {"t":"auth","speech":3,"mic":true,"locale":"zh-CN","installed":true,"engine":"SpeechAnalyzer"}
//   {"t":"ready"}
//   {"t":"partial","v":"我想问"}
//   {"t":"level","v":0.23}
//   {"t":"utterance","v":"我想问你个事"}
//   {"t":"final","v":"..."}
//   {"t":"error","v":"...","code":7}
//   {"t":"end"}
//
// stdin：stop / quit / mute / unmute
import Foundation
import AVFoundation
import Speech
import CoreAudio

// ---------------------------------------------------------------- 音频设备

/// 列出所有"能收音"的设备（名字 + id + 声道数）。不采集，不需要麦克风权限。
func listInputDevices() -> [(AudioDeviceID, String, Int)] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    let n = Int(size) / MemoryLayout<AudioDeviceID>.size
    guard n > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: n)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }

    var out: [(AudioDeviceID, String, Int)] = []
    for id in ids {
        var cfg = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var sz: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &cfg, 0, nil, &sz) == noErr, sz > 0 else { continue }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(sz), alignment: 16)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &cfg, 0, nil, &sz, raw) == noErr else { continue }
        let bufs = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        var channels = 0
        for b in bufs { channels += Int(b.mNumberChannels) }
        if channels == 0 { continue }

        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: CFString = "" as CFString
        var nsz = UInt32(MemoryLayout<CFString>.size)
        withUnsafeMutablePointer(to: &name) { p in
            _ = AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nsz, p)
        }
        out.append((id, name as String, channels))
    }
    return out
}

/// 把引擎的输入单元钉到指定设备（只影响本进程，不动系统默认设备）
func bindInputDevice(_ e: AVAudioEngine, _ id: AudioDeviceID) -> Bool {
    guard let au = e.inputNode.audioUnit else { return false }
    var d = id
    let st = AudioUnitSetProperty(
        au, kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global, 0, &d, UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    return st == noErr
}

/// 体检：把每个能收音的设备各开一遍，采几秒，报峰值电平。
/// 用来回答"到底哪个麦能收得到"这个问题 —— 靠猜是猜不出来的。
func probeAllDevices(seconds: Double) async {
    let devs = listInputDevices()
    emit(["t": "probeBegin", "v": devs.count])
    for d in devs {
        let e = AVAudioEngine()
        let inp = e.inputNode
        let bound = bindInputDevice(e, d.0)
        let f = inp.outputFormat(forBus: 0)
        guard f.channelCount > 0, f.sampleRate > 0 else {
            emit(["t": "probe", "id": Int(d.0), "name": d.1, "peak": 0, "bound": bound, "err": "格式不可用"])
            continue
        }
        var peak: Float = 0
        inp.installTap(onBus: 0, bufferSize: 2048, format: f) { b, _ in
            if let ch = b.floatChannelData?[0] {
                let n = Int(b.frameLength)
                if n > 0 {
                    var s: Float = 0
                    for i in 0..<n { s += ch[i] * ch[i] }
                    let r = sqrt(s / Float(n))
                    if r > peak { peak = r }
                }
            }
        }
        do {
            e.prepare()
            try e.start()
        } catch {
            inp.removeTap(onBus: 0)
            emit(["t": "probe", "id": Int(d.0), "name": d.1, "peak": 0, "bound": bound, "err": error.localizedDescription])
            continue
        }
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        inp.removeTap(onBus: 0)
        e.stop()
        emit(["t": "probe", "id": Int(d.0), "name": d.1, "peak": Double(peak), "bound": bound])
    }
    emit(["t": "end"])
    exit(0)
}

// ---------------------------------------------------------------- 输出

let outLock = NSLock()

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
    var line = d
    line.append(0x0A)
    outLock.lock()
    FileHandle.standardOutput.write(line)
    outLock.unlock()
}

func fail(_ msg: String, code: Int32) -> Never {
    emit(["t": "error", "v": msg, "code": Int(code)])
    emit(["t": "end"])
    exit(code)
}

// ---------------------------------------------------------------- 参数

func argValue(_ name: String, _ def: String) -> String {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: name), i + 1 < a.count { return a[i + 1] }
    return def
}
func hasFlag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

let localeId = argValue("--lang", "zh-CN")
let silenceMs = Double(argValue("--silence", "900")) ?? 900
let maxSeconds = Double(argValue("--max", "45")) ?? 45
let maxUtterances = Int(argValue("--utterances", "30")) ?? 30
let alwaysMode = hasFlag("--always")
let statusOnly = hasFlag("--status") || hasFlag("--probe")
let askMic = hasFlag("--request-mic")
let listMics = hasFlag("--list-mics")
/// 要钉住的输入设备名（子串匹配，大小写不敏感）；留空则自动优先 USB 麦
let wantMic = argValue("--mic", "")

// ---------------------------------------------------------------- 状态

let stateLock = NSLock()
var sessionText = ""      // 当前这句的识别文本
var lastChangeAt = Date()
var muted = false
/// 从什么时候开始闭麦的。超过 25 秒没被打开就强制打开 ——
/// 上层只要有一条路径漏了 unmute，麦克风就永久哑，而且完全没有报错。
var mutedAt: Date? = nil
var aecEnabled = false     // 系统回声消除是否开着（开着就可以边说边听）
var finished = false
var ending = false        // 正在收尾当前句
var starting = false      // 正在起新会话
var sessionGen = 0
var utteranceCount = 0
var startedAt = Date()

func isFinished() -> Bool {
    stateLock.lock(); defer { stateLock.unlock() }
    return finished
}

var engine = AVAudioEngine()
var tapInstalled = false
var inputCont: AsyncStream<AnalyzerInput>.Continuation?
var analyzer: SpeechAnalyzer?
var sessionTask: Task<Void, Never>?
var sessionTimer: DispatchSourceTimer?
var curLocale: Locale?
var curFormat: AVAudioFormat?

// ---------------------------------------------------------------- 音频格式

/// installTap 只吃硬件原生格式，SpeechAnalyzer 要它自己的格式，中间必须转换
var converter: AVAudioConverter?
var converterIn: AVAudioFormat?
var converterOut: AVAudioFormat?

func makeConverter(inF: AVAudioFormat, outF: AVAudioFormat) -> AVAudioConverter? {
    if inF == outF { return nil }
    guard let c = AVAudioConverter(from: inF, to: outF) else { return nil }
    // 声道数不同（立体声 → 单声道）时**必须**给 channelMap，否则转换直接 -50 paramErr。
    // 长度 = 输出声道数，值 = 取输入的哪个声道。
    if inF.channelCount != outF.channelCount {
        let n = Int(min(outF.channelCount, inF.channelCount))
        c.channelMap = (0..<n).map { NSNumber(value: $0) }
    }
    return c
}

// ---------------------------------------------------------------- 音频启动

var bufCount = 0
var convFail = 0
var lastAudioAt: TimeInterval = 0
var lastCaptureReportAt: TimeInterval = 0

/// 按一种「方案」配置并启动音频链路：开/关 AEC、钉/不钉设备。
///
/// 为什么要分方案：系统回声消除（VoiceProcessing）和"钉住指定设备"这两件事，
/// 在 USB 摄像头那种 4 声道 48k 的输入上会互相冲突，engine.start() 直接抛
/// -10875（FailedInitialization）。以前只有一种写法，一失败就整机哑掉；
/// 现在由外层按「效果从好到保底」依次试，第一个能起来的就用。
func startAudio(aec: Bool, bind: (AudioDeviceID, String)?, target: AVAudioFormat?) throws {
    if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    engine.stop()

    // 每次尝试都用**全新引擎**。一次 setVoiceProcessingEnabled 失败会把输入
    // 音频单元留在坏状态，同一个引擎上重试只会继续 -10875 / 或者 tap 装了却不回调。
    engine = AVAudioEngine()

    if aec {
        try engine.inputNode.setVoiceProcessingEnabled(true)
    }
    aecEnabled = aec
    if let b = bind, !bindInputDevice(engine, b.0) {
        throw NSError(domain: "workbunny", code: 23, userInfo: [NSLocalizedDescriptionKey: "无法连接指定麦克风"])
    }

    // 格式必须在配好 AEC / 设备**之后**、且重新取一次 inputNode 再读：
    // 上面两步都会重建输入节点，旧引用的格式是过期的（这正是 tap 装了不回调的原因）
    let inp = engine.inputNode
    let hw = inp.outputFormat(forBus: 0)
    guard hw.channelCount > 0, hw.sampleRate > 0 else {
        throw NSError(domain: "workbunny", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "麦克风输入格式不可用（可能没有输入设备）"])
    }
    converterIn = hw
    converterOut = target
    converter = target.flatMap { makeConverter(inF: hw, outF: $0) }
    if let tf = target { curFormat = tf }
    let ratio = (target?.sampleRate ?? hw.sampleRate) / hw.sampleRate

    emit(["t": "fmt", "hw": "\(hw)", "tgt": target.map { "\($0)" } ?? "nil"])

    bufCount = 0
    convFail = 0
    lastAudioAt = 0
    lastCaptureReportAt = 0
    inp.installTap(onBus: 0, bufferSize: 4096, format: hw) { buffer, _ in
        guard buffer.frameLength > 0 else { return }
        let now = ProcessInfo.processInfo.systemUptime
        stateLock.lock()
        let m = muted
        bufCount += 1
        let count = bufCount
        lastAudioAt = now
        let report = now - lastCaptureReportAt >= 1
        if report { lastCaptureReportAt = now }
        let continuation = inputCont
        stateLock.unlock()
        if count == 1 { emit(["t": "tap", "frames": Int(buffer.frameLength), "ch": Int(buffer.format.channelCount)]) }
        if report { emit(["t": "capture", "buffers": count, "muted": m]) }
        // 有回声消除时不用闭麦：自己说话也能继续听主人
        if m && !aecEnabled { return }

        var toSend: AVAudioPCMBuffer = buffer
        if let conv = converter, let tf = target {
            // ⚠ 两件事一起踩过，都别再改回去：
            //  1) 容量必须 >= **输入**帧数（convert 内部断言），少了会抛 ObjC 异常，
            //     Swift 接不住 —— 整个进程被打死，表现是"只有 tap、没有电平、永远听不见"。
            //  2) 48k → 16k 属于采样率转换，必须用带 block 的 API；
            //     简单的 convert(to:from:) 直接 -50 paramErr。
            let inFrames = Double(buffer.frameLength)
            let cap = AVAudioFrameCount(max(inFrames, inFrames * ratio) + 4096)
            if let out = AVAudioPCMBuffer(pcmFormat: tf, frameCapacity: cap) {
                var fed = false
                var cErr: NSError?
                let st = conv.convert(to: out, error: &cErr) { _, outStatus in
                    if fed { outStatus.pointee = .noDataNow; return nil }
                    fed = true
                    outStatus.pointee = .haveData
                    return buffer
                }
                if st == .error || cErr != nil {
                    convFail += 1
                    if convFail <= 3 {
                        emit(["t": "error",
                              "v": "重采样失败：" + (cErr?.localizedDescription ?? "status=\(st.rawValue)"),
                              "code": 21])
                    }
                    if convFail >= 3 { fail("麦克风格式转换持续失败，重新连接音频输入", code: 21) }
                    return
                } else if out.frameLength > 0 {
                    toSend = out
                }
            }
        }
        continuation?.yield(AnalyzerInput(buffer: toSend))

        // 电平必须从**原始硬件缓冲**算（Float32）；转换后的目标格式可能是 Int16，
        // floatChannelData 直接是 nil —— 之前电平一直是空的，就是这个原因。
        if count % 3 == 0, let ch = buffer.floatChannelData?[0] {
            let n = Int(buffer.frameLength)
            var sum: Float = 0
            for i in 0..<n { sum += ch[i] * ch[i] }
            let rms = (n > 0) ? sqrt(sum / Float(n)) : 0
            emit(["t": "level", "v": Double(min(1.0, rms * 6.0))])
        }
    }
    tapInstalled = true
    engine.prepare()
    try engine.start()
}

// ---------------------------------------------------------------- 上报一句

func emitUtterance(_ raw: String) {
    let seg = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !seg.isEmpty else { return }
    // 只认有实义文字，过滤纯标点/噪声
    let meaningful = seg.filter { $0.isLetter || $0.isNumber }
    guard meaningful.count >= 2 else { return }
    stateLock.lock(); utteranceCount += 1; let n = utteranceCount; stateLock.unlock()
    emit(["t": "utterance", "v": seg])

    if n >= maxUtterances {
        emit(["t": "recycle", "v": n])
        teardown()
        emit(["t": "end"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
    }
}

// ---------------------------------------------------------------- 会话

func teardown() {
    sessionTimer?.cancel()
    sessionTimer = nil
    inputCont?.finish()
    inputCont = nil
    if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    engine.stop()
}

@available(macOS 26.0, *)
func startSession() async {
    stateLock.lock()
    if finished || starting { stateLock.unlock(); return }
    starting = true
    sessionText = ""
    ending = false
    sessionGen += 1
    let gen = sessionGen
    stateLock.unlock()

    guard let locale = curLocale else {
        stateLock.lock(); starting = false; stateLock.unlock()
        return
    }
    let transcriber = SpeechTranscriber(
        locale: locale,
        transcriptionOptions: [],
        reportingOptions: [.volatileResults, .fastResults],
        attributeOptions: []
    )
    let (stream, cont) = AsyncStream<AnalyzerInput>.makeStream()
    let an = SpeechAnalyzer(modules: [transcriber])

    stateLock.lock()
    inputCont = cont
    analyzer = an
    starting = false
    stateLock.unlock()

    do {
        try await an.start(inputSequence: stream)
    } catch {
        emit(["t": "error", "v": "识别器启动失败：\(error.localizedDescription)", "code": 6])
        return
    }

    sessionTask = Task {
        do {
            for try await result in transcriber.results {
                if isFinished() { return }
                let text = String(result.text.characters)
                stateLock.lock()
                sessionText = text
                lastChangeAt = Date()
                stateLock.unlock()

                if result.isFinal {
                    await endSession(gen: gen, text: text)
                    return
                } else if !text.isEmpty {
                    emit(["t": "partial", "v": text])
                }
            }
        } catch {
            if !isFinished() {
                stateLock.lock(); let t = sessionText; stateLock.unlock()
                await endSession(gen: gen, text: t)
            }
        }
    }
}

/// 收掉当前这句：上报 → （常驻）立刻起下一个会话
func endSession(gen: Int, text: String) async {
    stateLock.lock()
    if gen != sessionGen { stateLock.unlock(); return }
    sessionGen += 1
    ending = false
    let wasFinished = finished
    stateLock.unlock()
    if wasFinished { return }

    emitUtterance(text)

    if alwaysMode {
        await startSession()
    } else {
        stateLock.lock(); finished = true; stateLock.unlock()
        emit(["t": "final", "v": text])
        teardown()
        emit(["t": "end"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exit(0) }
    }
}

/// 判定这句说完了：让 analyzer 吐 final，结果流里会走 endSession
func beginEnd() {
    stateLock.lock()
    if ending || finished || starting { stateLock.unlock(); return }
    ending = true
    let an = analyzer
    let gen = sessionGen
    stateLock.unlock()

    Task {
        try? await an?.finalizeAndFinishThroughEndOfInput()
        // 兜底：finalize 没在 1.8s 内回 final，就自己收
        try? await Task.sleep(nanoseconds: 1_800_000_000)
        stateLock.lock()
        let still = ending
        let t = sessionText
        stateLock.unlock()
        if still { await endSession(gen: gen, text: t) }
    }
}

// ---------------------------------------------------------------- 主流程

func localeIdentifier(_ l: Locale) -> String { l.identifier(.bcp47) }

func resolveLocale(_ installed: [Locale]) -> Locale? {
    let want = localeId.replacingOccurrences(of: "_", with: "-").lowercased()
    if let exact = installed.first(where: { localeIdentifier($0).lowercased() == want }) { return exact }
    let lang = String(want.split(separator: "-").first ?? "")
    if let sameLang = installed.first(where: { localeIdentifier($0).lowercased().hasPrefix(lang) }) { return sameLang }
    return nil
}

func reportAndExit(_ speech: Int, _ mic: Bool, _ extra: [String: Any] = [:]) -> Never {
    var d: [String: Any] = ["t": "auth", "speech": speech, "mic": mic]
    for (k, v) in extra { d[k] = v }
    emit(d)
    emit(["t": "end"])
    exit(0)
}

func requestMic() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
}

/// 只读判断，绝不弹窗。授权必须由**宿主应用**去要（Electron 的
/// systemPreferences.askForMediaAccess），TCC 才会把授权记在应用本身。
/// 由这个裸可执行文件去要，授权会记在一个既没 bundle id、路径又随打包变化的
/// 身份上 —— 表现就是每次启动都重新弹框。
func micAuthorized() -> Bool {
    AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
}

@available(macOS 26.0, *)
func run() async {
    // 1. 麦克风权限（--status 默认不打扰；--no-mic-ask 时也绝不弹窗）
    var micOK: Bool
    if (statusOnly && !askMic) || hasFlag("--no-mic-ask") {
        micOK = micAuthorized()
    } else {
        micOK = await requestMic()
    }

    // 没授权就不要往下走：接着建音频单元只会失败退出，让上层以为出了别的问题。
    // 状态查询模式例外 —— 它还要把"语言包有没有装"报回去。
    if !micOK && !statusOnly {
        emit(["t": "auth", "speech": 3, "mic": false,
              "locale": localeIdentifier(Locale(identifier: "zh-CN")),
              "engine": "SpeechAnalyzer", "error": "麦克风还没授权"])
        emit(["t": "end"])
        exit(3)
    }

    // 2. 语言资产
    let supported = await SpeechTranscriber.supportedLocales
    let installed = await SpeechTranscriber.installedLocales
    guard let locale = resolveLocale(supported) else {
        reportAndExit(1, micOK, ["error": "系统不支持所选语音识别语言：\(localeId)"])
    }
    let localeReady = installed.contains { localeIdentifier($0) == localeIdentifier(locale) }
    curLocale = locale

    if statusOnly {
        reportAndExit(localeReady ? 3 : 1, micOK, [
            "locale": localeIdentifier(locale),
            "installed": localeReady,
            "engine": "SpeechAnalyzer",
        ])
    }

    guard micOK else { fail("麦克风未授权（系统设置 → 隐私与安全性 → 麦克风）", code: 4) }

    // 3. 没装资产就地装
    if !localeReady {
        emit(["t": "installing", "locale": localeIdentifier(locale)])
        let probe = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
        do {
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
                try await req.downloadAndInstall()
            }
        } catch {
            fail("语音模型安装失败：\(error.localizedDescription)", code: 12)
        }
    }

    emit([
        "t": "auth", "speech": 3, "mic": true,
        "locale": localeIdentifier(locale), "engine": "SpeechAnalyzer", "always": alwaysMode,
    ])

    // 4. 先算好目标格式与转换器，再装 tap
    let probeTr = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [probeTr])
    curFormat = targetFormat

    // 选输入设备：很多机器内置麦根本收不到桌面音箱的声音，必须钉到 USB 麦上。
    // 只影响本进程，不改系统默认设备。
    let devs = listInputDevices()
    var picked: (AudioDeviceID, String)? = nil
    if !wantMic.isEmpty && wantMic.lowercased() != "auto" {
        picked = devs.first { $0.1.range(of: wantMic, options: .caseInsensitive) != nil }.map { ($0.0, $0.1) }
    }

    // ── 音频方案阶梯 ────────────────────────────────────────────────
    // 从"效果最好"到"最保底"依次试，第一个起得来的就用。宁可少回声消除，
    // 也绝不能哑。
    //
    // 系统回声消除默认**不开**：实测这台机器的 VoiceProcessingIO 在 USB 摄像头
    // 和内置麦上都一开就 -10875（FailedInitialization），每次启动还白撞两次墙、
    // 多花一两秒。真要用再挂 --aec 打开（会自己降级，不会哑）。
    var plans: [(String, Bool, Bool)] = []   // (名字, 开AEC, 钉设备)
    if hasFlag("--aec") {
        if picked != nil { plans.append(("AEC+指定麦", true, true)) }
        plans.append(("AEC", true, false))
    }
    if picked != nil { plans.append(("指定麦", false, true)) }
    plans.append(("系统默认", false, false))

    var audioOK = false
    var lastErr = ""
    for plan in plans {
        do {
            try startAudio(aec: plan.1, bind: plan.2 ? picked : nil, target: targetFormat)
            // AVAudioEngine.start() can succeed while a USB device never sends
            // buffers. Do not report ready until actual microphone data arrives.
            var received = false
            for _ in 0..<20 {
                received = stateLock.withLock { bufCount > 0 }
                if received { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            if !received { throw NSError(domain: "workbunny", code: 22,
                userInfo: [NSLocalizedDescriptionKey: "输入设备没有音频数据"]) }
            audioOK = true
            if plan.2, let p = picked {
                emit(["t": "mic", "on": true, "name": p.1, "id": Int(p.0)])
            } else {
                emit(["t": "mic", "on": false, "name": "", "id": 0, "v": "使用系统默认输入设备"])
            }
            emit(["t": "audio", "ok": true, "plan": plan.0])
            break
        } catch {
            lastErr = error.localizedDescription
            emit(["t": "warn", "v": "音频方案「\(plan.0)」起不来：\(lastErr)"])
        }
    }
    if !audioOK { fail("音频启动失败：\(lastErr)", code: 6) }
    emit(["t": "aec", "on": aecEnabled])
    startedAt = Date()
    lastChangeAt = Date()

    await startSession()
    emit(["t": "ready", "captureHeartbeat": true])

    // 5. 静音 / 超时
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
    timer.schedule(deadline: .now() + 0.15, repeating: 0.15)
    timer.setEventHandler {
        if isFinished() { return }
        stateLock.lock()
        let audioAge = ProcessInfo.processInfo.systemUptime - lastAudioAt
        if audioAge > 4 {
            stateLock.unlock()
            fail("麦克风音频输入中断，正在重新连接", code: 22)
        }
        // 兜底：闭麦超过 25 秒还没被打开，就当上层漏了 unmute，自己开。
        // 宁可把自己的一句话当成主人说的，也不能让麦克风永久哑掉。
        if let at = mutedAt, Date().timeIntervalSince(at) > 125 {
            muted = false
            mutedAt = nil
            stateLock.unlock()
            emit(["t": "warn", "v": "闭麦超过 25 秒，自动开麦（上层漏了 unmute）"])
            lastChangeAt = Date()
            return
        }
        let m = muted
        let st = sessionText
        let silent = Date().timeIntervalSince(lastChangeAt)
        let endingNow = ending
        stateLock.unlock()
        if m || endingNow { return }
        let hasText = !st.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        if alwaysMode {
            if hasText && silent * 1000 > silenceMs { beginEnd() }
        } else {
            let long = Date().timeIntervalSince(startedAt)
            if (hasText && silent * 1000 > silenceMs) || long > maxSeconds { beginEnd() }
        }
    }
    sessionTimer = timer
    timer.resume()
}

// ---------------------------------------------------------------- 入口

// 只枚举设备：不采集、不弹窗，可以随便从命令行跑
if listMics {
    let devs = listInputDevices()
    emit(["t": "mics", "v": devs.map { ["id": Int($0.0), "name": $0.1, "ch": $0.2] }])
    emit(["t": "end"])
    exit(0)
}

// 逐个麦克风体检（需要一个有麦克风权限的父进程来跑）
if hasFlag("--probe-all") {
    let sec = Double(argValue("--probe-sec", "3")) ?? 3
    if #available(macOS 26.0, *) {
        Task { await probeAllDevices(seconds: sec) }
        RunLoop.main.run()
    } else {
        fail("需要 macOS 26 及以上", code: 5)
    }
}

if #available(macOS 26.0, *) {
    Task { await run() }
} else {
    fail("这个 macOS 版本不支持 SpeechAnalyzer（需要 26 及以上）", code: 5)
}

// stdin 指令
DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        let cmd = line.trimmingCharacters(in: .whitespaces)
        switch cmd {
        case "stop":
            if isFinished() { continue }
            beginEnd()
            return
        case "quit":
            exit(0)
        case "mute":
            stateLock.lock(); muted = true; mutedAt = Date(); stateLock.unlock()
        case "unmute":
            stateLock.lock(); muted = false; mutedAt = nil; lastChangeAt = Date(); stateLock.unlock()
        default:
            break
        }
    }
    // stdin 断了 = 父进程没了。不留孤儿进程（--status 例外：它不读 stdin，随时会自己退）
    if !statusOnly { exit(0) }
}

// 父进程看门狗：父进程一死，我们立刻跟着退，避免用户"退出了但麦克风还占着"
let parentPid = getppid()
let parentWatch = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
parentWatch.schedule(deadline: .now() + 3, repeating: 3)
parentWatch.setEventHandler {
    if getppid() != parentPid || getppid() == 1 { exit(0) }
}
parentWatch.resume()

// 兜底
if statusOnly {
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
        emit(["t": "error", "v": "查询语音状态超时", "code": 10])
        emit(["t": "end"])
        exit(0)
    }
} else if !alwaysMode {
    DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds + 12) {
        if !isFinished() { beginEnd() }
    }
}

RunLoop.main.run()
