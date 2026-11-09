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
//   再新建一个继续听。片段 final 只确认该音频范围；收尾期间的音频排队到下一会话。
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
import Darwin

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
    exitASR(0)
}

// ---------------------------------------------------------------- 输出

let outLock = NSLock()
var speechDiagnostic: SpeechDiagnostic?
var diagnosticExitClaimed = false
let diagnosticExitLock = NSLock()

func endSpeechDiagnostic(_ code: Int) {
    guard let diagnostic = speechDiagnostic else { return }
    diagnosticExitLock.lock()
    if diagnosticExitClaimed { diagnosticExitLock.unlock(); return }
    diagnosticExitClaimed = true; diagnosticExitLock.unlock()
    // This route never awaits SpeechAnalyzer. A separate absolute deadline
    // reaps the process even if engine shutdown or a filesystem write hangs.
    stateLock.lock(); finished = true; ending = true; sessionGen += 1; stateLock.unlock()
    teardown()
    diagnostic.finish(code: code) { Darwin._exit(Int32(diagnostic.reasonCode)) }
}

func exitASR(_ code: Int32) -> Never {
    if let diagnostic = speechDiagnostic {
        // Error paths can run while the audio state lock is held. Never wait
        // for that lock or SpeechAnalyzer to flush this private writer.
        diagnostic.finish(code: Int(code)) { Darwin._exit(Int32(diagnostic.reasonCode)) }
        DispatchQueue.global().async { teardown() }
        _ = DispatchSemaphore(value: 0).wait(timeout: .now() + .milliseconds(200))
        Darwin._exit(code)
    }
    Darwin.exit(code)
}

func emit(_ obj: [String: Any]) {
    var annotated = WakeName.annotate(obj)
    if speechDiagnostic != nil {
        // emit can run while stateLock is already held. This diagnostic-only
        // snapshot must not reacquire that lock or affect recognition state.
        annotated["diagnosticGen"] = sessionGen
        annotated["diagnosticUptime"] = ProcessInfo.processInfo.systemUptime
    }
    speechDiagnostic?.record("native-output", ["output": annotated])
    guard let d = try? JSONSerialization.data(withJSONObject: annotated) else { return }
    var line = d
    line.append(0x0A)
    outLock.lock()
    FileHandle.standardOutput.write(line)
    outLock.unlock()
}

func fail(_ msg: String, code: Int32) -> Never {
    emit(["t": "error", "v": msg, "code": Int(code)])
    emit(["t": "end"])
    exitASR(code)
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
let speechTraceEnabled = hasFlag("--speech-trace")
/// 要钉住的输入设备名（子串匹配，大小写不敏感）；留空则自动优先 USB 麦
let wantMic = argValue("--mic", "")

// ---------------------------------------------------------------- 状态

let stateLock = NSLock()
var sessionText = ""      // 当前这句的识别文本
var sessionTranscript = SpeechTranscript()
var sessionAcousticEvidence = SpeechAcousticEvidence()
let speechActivity = SpeechActivity()
var endpointPolicy = SpeechEndpointPolicy(generation: 0, silenceMs: silenceMs, maxSeconds: maxSeconds)
var finalizationBarrier = SpeechFinalizationBarrier(generation: 0)
// Accessed only under stateLock. Tickets are generation-bound so a delayed job
// cannot consume or clear a newer generation's pending notification.
struct SpeechEndpointNotifications {
    struct Ticket: Equatable { let generation: Int; let serial: Int }
    private var generation = 0, serial = 0
    private var pending: Ticket?
    private var closed = false
    mutating func reset(generation: Int) { self.generation = generation; pending = nil; closed = false }
    mutating func close() { closed = true; pending = nil }
    mutating func request(generation: Int) -> Ticket? {
        guard !closed, generation == self.generation, pending == nil else { return nil }
        serial += 1; let ticket = Ticket(generation: generation, serial: serial); pending = ticket; return ticket
    }
    mutating func claim(_ ticket: Ticket, generation: Int) -> Bool {
        guard !closed, generation == self.generation, ticket.generation == generation, pending == ticket else { return false }
        pending = nil; return true
    }
}
var endpointNotifications = SpeechEndpointNotifications()
var activityOutputSequence = 0
var finalizedActivitySequence = 0
// Test injection changes only the scheduler/handler, never a model or engine.
var enqueueEndpointNotification: (@escaping () -> Void) -> Void = { work in DispatchQueue.global().async(execute: work) }
var handleQuietEndpoint: (Int) -> Void = { beginEnd("quiet", expectedGen: $0) }
var pendingAudio: [AVAudioPCMBuffer] = []
var pendingDiagnosticSequences: [ObjectIdentifier: Int] = [:]
var pendingAudioTimes: [ObjectIdentifier: TimeInterval] = [:]
var pendingAudioSeconds = 0.0
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

// Diagnostic-only metadata. Stage names and numeric fields are allowlisted;
// transcript text, PCM data and device identity cannot enter these events.
enum SpeechTraceStage: String, CaseIterable {
    case tapVPIO = "tap-vpio", analyzerInput = "analyzer-input", replay
    case sessionStart = "session-start", result, finishStart = "finish-start"
    case finishReturn = "finish-return", resultsEnd = "results-end", utterance, recycle
}
let speechTraceFields: Set<String> = ["at", "gen", "currentGen", "frames", "rate", "channels", "measuredChannels", "rms", "peak", "muted", "aec", "accepted", "converted", "conversionError", "buffers", "pendingFrames", "pendingSeconds", "directBuffers", "directFrames", "queuedBuffers", "queuedFrames", "replayedBuffers", "replayedFrames", "start", "end", "finalizedThrough", "isFinal", "textChars", "combinedChars", "removedSegments", "touchesFinalized", "confirmed", "current", "ok", "utteranceCount"]
var traceDirectBuffers = 0, traceDirectFrames = 0, traceQueuedBuffers = 0, traceQueuedFrames = 0
var traceReplayedBuffers = 0, traceReplayedFrames = 0

func speechTraceRecord(_ stage: SpeechTraceStage, _ fields: [String: Any], enabled: Bool = speechTraceEnabled) -> [String: Any]? {
    guard enabled else { return nil }
    var record: [String: Any] = ["t": "speechTrace", "stage": stage.rawValue, "at": ProcessInfo.processInfo.systemUptime]
    for (key, value) in fields where speechTraceFields.contains(key) {
        if let number = value as? NSNumber, number.doubleValue.isFinite { record[key] = number }
        else if let numbers = value as? [NSNumber], numbers.count <= 64,
                numbers.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite }) { record[key] = numbers }
    }
    return record
}
func traceSpeech(_ stage: SpeechTraceStage, _ fields: [String: Any]) {
    if let record = speechTraceRecord(stage, fields) { emit(record) }
}
// Caller already owns stateLock. No extra lock is added to the tap route.
func speechTraceStateLocked(gen: Int? = nil) -> [String: Any] {
    ["gen": gen ?? sessionGen, "currentGen": sessionGen, "pendingFrames": pendingAudio.reduce(0) { $0 + Int($1.frameLength) }, "pendingSeconds": pendingAudioSeconds,
     "directBuffers": traceDirectBuffers, "directFrames": traceDirectFrames, "queuedBuffers": traceQueuedBuffers, "queuedFrames": traceQueuedFrames,
     "replayedBuffers": traceReplayedBuffers, "replayedFrames": traceReplayedFrames]
}
func traceSpeechState(_ stage: SpeechTraceStage, gen: Int? = nil, fields: [String: Any] = [:]) {
    guard speechTraceEnabled else { return }
    stateLock.lock(); var snapshot = speechTraceStateLocked(gen: gen); stateLock.unlock()
    snapshot.merge(fields) { _, next in next }; traceSpeech(stage, snapshot)
}
func speechTraceLevels(_ buffer: AVAudioPCMBuffer) -> [String: Any] {
    let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
    let floats = buffer.floatChannelData, int16 = buffer.int16ChannelData, int32 = buffer.int32ChannelData
    let measured = floats != nil || int16 != nil || int32 != nil ? min(channels, 64) : 0
    let interleaved = buffer.format.isInterleaved, stride = buffer.stride
    var rms: [Double] = [], peak: [Double] = []
    for channel in 0..<measured {
        let pointer = interleaved ? 0 : channel, offset = interleaved ? channel : 0
        var sum = 0.0, highest = 0.0
        for frame in 0..<frames {
            let index = frame * stride + offset
            let sample: Double
            if let data = floats { sample = Double(data[pointer][index]) }
            else if let data = int16 { sample = Double(data[pointer][index]) / 32768 }
            else if let data = int32 { sample = Double(data[pointer][index]) / 2147483648 }
            else { continue }
            if sample.isFinite { sum += sample * sample; highest = max(highest, abs(sample)) }
        }
        rms.append(frames > 0 ? sqrt(sum / Double(frames)) : 0); peak.append(highest)
    }
    return ["frames": frames, "rate": buffer.format.sampleRate, "channels": channels, "measuredChannels": measured, "rms": rms, "peak": peak]
}

func isFinished() -> Bool {
    stateLock.lock(); defer { stateLock.unlock() }
    return finished
}

let speakerFeatures = SpeakerFeatures(output: emit)
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

// The routing lock binds acoustic evidence to the same generation and order as
// actual Analyzer offers, including audio captured during the previous drain.
func requestQuietEndpointLocked(gen: Int) {
    guard gen == sessionGen, !finished, !ending, !starting,
          endpointPolicy.decision(at: ProcessInfo.processInfo.systemUptime, generation: gen) == .quiet,
          let ticket = endpointNotifications.request(generation: gen) else { return }
    enqueueEndpointNotification {
        // The producer still owns stateLock until after its actual yield.
        stateLock.lock()
        let claimed = endpointNotifications.claim(ticket, generation: sessionGen)
        let valid = claimed && gen == sessionGen && !finished && !ending && !starting &&
            endpointPolicy.decision(at: ProcessInfo.processInfo.systemUptime, generation: gen) == .quiet
        stateLock.unlock()
        if valid { handleQuietEndpoint(gen) } // beginEnd rechecks under its lock.
    }
}
func observeDeliveredAudioLocked(_ buffer: AVAudioPCMBuffer, gen: Int, at: TimeInterval, seq: Int?, route: String) {
    let receivedAt = ProcessInfo.processInfo.systemUptime
    let observed = gen == sessionGen && !finished ? speechActivity.observe(buffer, generation: gen, at: at) :
        SpeechActivity.Observation(generation: gen, state: .unknown, quietSeconds: 0, at: receivedAt, frames: [])
    if gen == sessionGen && !finished {
        sessionAcousticEvidence.append(seconds: Double(buffer.frameLength) / buffer.format.sampleRate,
            capturedAt: at, classified: observed.frames)
    }
    let emittedAt = ProcessInfo.processInfo.systemUptime
    let valid = observed.generation == gen && gen == sessionGen && !finished && observed.at.isFinite &&
        observed.at >= 0 && observed.at <= emittedAt && observed.quietSeconds.isFinite && observed.quietSeconds >= 0
    let state: SpeechActivity.State = valid ? observed.state : .unknown
    let quietSeconds = state == .quiet ? observed.quietSeconds : 0
    let observedAt = valid ? observed.at : emittedAt
    let freshActivity = endpointPolicy.observe(SpeechEndpointPolicy.Activity(rawValue: state.rawValue) ?? .unknown,
        quietSeconds: quietSeconds, at: observedAt, generation: gen, now: emittedAt)
    // Reuse the same generation/freshness check: delayed replay cannot refresh
    // a current acoustic descriptor's speech hint. No Analyzer input is gated.
    if freshActivity && state == .active { speakerFeatures.speechDetected(true) }
    activityOutputSequence += 1
    emit(["t": "activity", "state": state.rawValue, "quietSeconds": quietSeconds, "at": observedAt,
          "emittedAt": emittedAt, "gen": gen, "seq": activityOutputSequence])
    var metadata: [String: Any] = ["gen": gen, "state": state.rawValue,
        "at": observedAt, "quietSeconds": quietSeconds, "route": route, "activitySeq": activityOutputSequence]
    if let seq { metadata["seq"] = seq }
    speechDiagnostic?.record("audio-activity", metadata)
    requestQuietEndpointLocked(gen: gen)
}

func enqueueAudio(_ buffer: AVAudioPCMBuffer, diagnosticSequence: Int? = nil) {
    let capturedAt = ProcessInfo.processInfo.systemUptime
    stateLock.lock()
    defer { stateLock.unlock() }
    if let continuation = inputCont {
        observeDeliveredAudioLocked(buffer, gen: sessionGen, at: capturedAt, seq: diagnosticSequence, route: "direct")
        let offered = continuation.yield(AnalyzerInput(buffer: buffer))
        speechDiagnostic?.offer(seq: diagnosticSequence, gen: sessionGen, route: "direct", outcome: SpeechDiagnostic.yieldCategory(offered))
        if speechTraceEnabled { traceDirectBuffers += 1; traceDirectFrames += Int(buffer.frameLength) }
    } else if !finished {
        let duration = Double(buffer.frameLength) / buffer.format.sampleRate
        guard pendingAudioSeconds + duration <= 5,
              let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            fail("语音切句缓冲已满，请重新说出完整要求", code: 24)
        }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (from, to) in zip(source, destination) {
            if let sourceData = from.mData, let targetData = to.mData { memcpy(targetData, sourceData, Int(from.mDataByteSize)) }
        }
        pendingAudio.append(copy); pendingAudioSeconds += duration
        pendingAudioTimes[ObjectIdentifier(copy)] = capturedAt
        if let seq = diagnosticSequence { pendingDiagnosticSequences[ObjectIdentifier(copy)] = seq }
        speechDiagnostic?.offer(seq: diagnosticSequence, gen: sessionGen, route: "queued", outcome: "queued-not-offered")
        if speechTraceEnabled { traceQueuedBuffers += 1; traceQueuedFrames += Int(buffer.frameLength) }
    }
}

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
    inp.installTap(onBus: 0, bufferSize: 4096, format: hw) { buffer, audioTime in
        guard buffer.frameLength > 0 else { return }
        let now = ProcessInfo.processInfo.systemUptime
        stateLock.lock()
        let m = muted
        let captureGen = sessionGen
        bufCount += 1
        let count = bufCount
        lastAudioAt = now
        let report = now - lastCaptureReportAt >= 1
        if report { lastCaptureReportAt = now }
        let traceState = speechTraceEnabled && report ? speechTraceStateLocked() : nil
        stateLock.unlock()
        if count == 1 { emit(["t": "tap", "frames": Int(buffer.frameLength), "ch": Int(buffer.format.channelCount)]) }
        if report { emit(["t": "capture", "buffers": count, "muted": m]) }
        if var metadata = traceState {
            metadata.merge(speechTraceLevels(buffer)) { _, next in next }
            metadata.merge(["buffers": count, "muted": m, "aec": aecEnabled, "accepted": !m || aecEnabled]) { _, next in next }
            traceSpeech(.tapVPIO, metadata)
        }
        speakerFeatures.process(buffer)
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
                    if speechTraceEnabled && report { traceSpeechState(.analyzerInput, fields: ["frames": 0, "conversionError": true, "accepted": false]) }
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
        let diagnosticSequence = speechDiagnostic?.capture(toSend, gen: captureGen, audioTime: audioTime)
        enqueueAudio(toSend, diagnosticSequence: diagnosticSequence)
        if speechTraceEnabled && report {
            var metadata = speechTraceLevels(toSend)
            metadata.merge(["accepted": true, "converted": toSend !== buffer, "conversionError": false]) { _, next in next }
            traceSpeechState(.analyzerInput, fields: metadata)
        }

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

func emitTranscriptUpdate(_ text: String, gen: Int, audioRange: (Double, Double)?, retracting: Bool) {
    if !text.isEmpty {
        var output: [String: Any] = ["t":"partial", "v":text, "gen":gen,
            "emittedAt":ProcessInfo.processInfo.systemUptime]
        if let (from, to) = audioRange { output["audioStartAt"] = from; output["audioEndAt"] = to }
        if speechDiagnostic != nil { output["diagnosticSourceGen"] = gen }
        emit(output)
    } else if retracting {
        // Withdrawing a provisional range is not a finalizer receipt and
        // carries only the source whose unconfirmed words must be removed.
        emit(["t":"retract", "gen":gen, "emittedAt":ProcessInfo.processInfo.systemUptime])
    }
}

func emitUtterance(_ raw: String, traceGen: Int? = nil, audioRange: (Double, Double)? = nil) {
    let seg = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !seg.isEmpty else { return }
    // Text eligibility belongs to the shared host turn policy. A provisional
    // short answer must receive its final too, including a single Chinese word.
    stateLock.lock(); utteranceCount += 1; let n = utteranceCount; stateLock.unlock()
    traceSpeechState(.utterance, gen: traceGen, fields: ["textChars": seg.count, "utteranceCount": n, "accepted": true])
    var output: [String: Any] = ["t": "utterance", "v": seg]
    if let gen = traceGen { output["gen"] = gen }
    if let (from, to) = audioRange { output["audioStartAt"] = from; output["audioEndAt"] = to }
    output["emittedAt"] = ProcessInfo.processInfo.systemUptime
    if speechDiagnostic != nil, let gen = traceGen { output["diagnosticSourceGen"] = gen }
    emit(output)

    if n >= maxUtterances {
        stateLock.lock(); finished = true; stateLock.unlock()
        traceSpeechState(.recycle, gen: traceGen, fields: ["utteranceCount": n])
        emit(["t": "recycle", "v": n])
        teardown()
        emit(["t": "end"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exitASR(0) }
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
    sessionTranscript = SpeechTranscript()
    sessionAcousticEvidence = SpeechAcousticEvidence()
    lastChangeAt = Date()
    ending = false
    sessionGen += 1
    let gen = sessionGen
    endpointPolicy = SpeechEndpointPolicy(generation: gen, silenceMs: silenceMs, maxSeconds: maxSeconds)
    finalizationBarrier = SpeechFinalizationBarrier(generation: gen)
    finalizedActivitySequence = 0
    endpointNotifications.reset(generation: gen)
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
    speakerFeatures.requireSpeechConfirmation()
    // SpeechDetector is an input gate, not just a reporting module. On saved
    // processed PCM it omitted complete clauses; the transcriber alone kept
    // them. Independent VAD observes every delivered buffer without gating it.
    let an = SpeechAnalyzer(modules: [transcriber])
    let context = AnalysisContext()
    context.contextualStrings[.general] = WakeName.configured.names
    try? await an.setContext(context)

    stateLock.lock()
    // Flush under the same lock as audio routing so newer buffers cannot
    // overtake audio captured while the previous analyzer was draining.
    let replayBuffers = speechTraceEnabled ? pendingAudio.count : 0
    let replayFrames = speechTraceEnabled ? pendingAudio.reduce(0) { $0 + Int($1.frameLength) } : 0
    for buffer in pendingAudio {
        let seq = pendingDiagnosticSequences.removeValue(forKey: ObjectIdentifier(buffer))
        let at = pendingAudioTimes.removeValue(forKey: ObjectIdentifier(buffer)) ?? ProcessInfo.processInfo.systemUptime
        observeDeliveredAudioLocked(buffer, gen: gen, at: at, seq: seq, route: "replay")
        let offered = cont.yield(AnalyzerInput(buffer: buffer))
        speechDiagnostic?.offer(seq: seq, gen: gen, route: "replay", outcome: SpeechDiagnostic.yieldCategory(offered))
    }
    if speechTraceEnabled { traceReplayedBuffers += replayBuffers; traceReplayedFrames += replayFrames }
    pendingAudio.removeAll(); pendingAudioSeconds = 0
    inputCont = cont
    analyzer = an
    starting = false
    stateLock.unlock()
    if speechTraceEnabled {
        traceSpeechState(.replay, gen: gen, fields: ["buffers": replayBuffers, "frames": replayFrames])
        traceSpeechState(.sessionStart, gen: gen)
    }

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
                stateLock.lock()
                guard gen == sessionGen && !finished else { stateLock.unlock(); return }
                let resultText = String(result.text.characters)
                let supported = sessionAcousticEvidence.supports(start: result.range.start.seconds, end: result.range.end.seconds)
                // Keep the complete input in SpeechAnalyzer. Only recognized
                // ranges with independent speech evidence may become words.
                // An unsupported revision also removes its volatile words.
                let observation = sessionTranscript.accept(text: supported ? resultText : "", start: result.range.start.seconds,
                    end: result.range.end.seconds, finalizedThrough: result.resultsFinalizationTime.seconds, observing: speechTraceEnabled)
                let text = sessionTranscript.text
                let audioRange = sessionTranscript.range.flatMap { sessionAcousticEvidence.captureRange(start: $0.0, end: $0.1) }
                let retracted = text.isEmpty && !sessionText.isEmpty
                if text != sessionText { lastChangeAt = Date() }
                sessionText = text
                endpointPolicy.recordText(text, at: ProcessInfo.processInfo.systemUptime, generation: gen)
                var traceMetadata = speechTraceEnabled ? speechTraceStateLocked(gen: gen) : nil
                if speechTraceEnabled {
                    traceMetadata?.merge(["start": result.range.start.seconds, "end": result.range.end.seconds,
                        "finalizedThrough": result.resultsFinalizationTime.seconds, "isFinal": result.isFinal,
                        "textChars": resultText.count, "combinedChars": text.count, "removedSegments": observation?.removedSegments ?? 0,
                        "touchesFinalized": observation?.touchesFinalized ?? false, "accepted": supported && (observation?.accepted ?? false),
                        "confirmed": sessionTranscript.confirmed]) { _, next in next }
                }
                stateLock.unlock()
                speechDiagnostic?.record("raw-result", ["gen": gen, "text": resultText, "combinedText": text,
                    "start": result.range.start.seconds, "end": result.range.end.seconds,
                    "finalizedThrough": result.resultsFinalizationTime.seconds, "isFinal": result.isFinal, "acousticSupport": supported])
                if let metadata = traceMetadata { traceSpeech(.result, metadata) }
                // A final result is one phrase, not the end of this session.
                emitTranscriptUpdate(text, gen: gen, audioRange: audioRange, retracting: retracted)
            }
            stateLock.lock()
            let text = sessionText, confirmed = sessionTranscript.confirmed
            let live = gen == sessionGen && !finished
            if live { finalizationBarrier.resultsEnded(confirmed: confirmed, text: text, generation: gen) }
            let invalidEnd = live && finalizationBarrier.failure != nil
            stateLock.unlock()
            speechDiagnostic?.record("results-end", ["gen": gen, "ok": true, "current": live, "confirmed": confirmed, "text": text])
            if speechTraceEnabled {
                var fields: [String: Any] = ["ok": true, "current": live]
                if live { fields.merge(["confirmed": confirmed, "combinedChars": text.count]) { _, next in next } }
                traceSpeechState(.resultsEnd, gen: gen, fields: fields)
            }
            if live {
                guard !invalidEnd else { fail("语音收尾未能确认完整结果，请重新说出完整要求", code: 24) }
                await publishFinalizedSession(gen: gen)
            }
        } catch {
            stateLock.lock(); let live = gen == sessionGen && !finished
            if live { finalizationBarrier.fail(.results, generation: gen) }; stateLock.unlock()
            traceSpeechState(.resultsEnd, gen: gen, fields: ["ok": false, "current": live])
            speechDiagnostic?.record("results-end", ["gen": gen, "ok": false, "current": live])
            if live { fail("语音识别中断，未提交未确认的句子，请重新说出完整要求", code: 24) }
        }
    }
}

@available(macOS 26.0, *)
func publishFinalizedSession(gen: Int) async {
    stateLock.lock()
    let text = gen == sessionGen && !finished ? finalizationBarrier.claim(generation: gen) : nil
    stateLock.unlock()
    if let text { await endSession(gen: gen, text: text) }
}

func abortUnconfirmedSession(gen: Int, reason: String) {
    stateLock.lock()
    guard gen == sessionGen && !finished && !ending else { stateLock.unlock(); return }
    if reason != "capture-max-duration" && endpointPolicy.decision(at: ProcessInfo.processInfo.systemUptime, generation: gen) != .unconfirmed { stateLock.unlock(); return }
    finalizationBarrier.fail(.unconfirmed, generation: gen)
    finished = true; ending = true; sessionGen += 1
    stateLock.unlock()
    speechDiagnostic?.record("endpoint-abort", ["gen": gen, "reason": reason])
    fail("语音输入尚未可靠确认，已取消本段识别并准备重连，请重新说出完整要求", code: 25)
}

/// 收掉当前这句：上报 → （常驻）立刻起下一个会话
func endSession(gen: Int, text: String) async {
    stateLock.lock()
    if gen != sessionGen { stateLock.unlock(); return }
    sessionGen += 1
    ending = true
    inputCont = nil
    let wasFinished = finished
    let coveredSequence = finalizedActivitySequence
    let audioRange = sessionTranscript.range.flatMap { sessionAcousticEvidence.captureRange(start: $0.0, end: $0.1) }
    stateLock.unlock()
    if wasFinished { return }

    emitUtterance(text, traceGen: gen, audioRange: audioRange)
    // Empty means this exact delivered audio was finalized and drained with
    // no words. This is coverage evidence, never a new utterance/authority.
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && coveredSequence > 0 {
        emit(["t": "audioFinal", "gen": gen, "coveredSeq": coveredSequence])
    }

    if alwaysMode {
        if !isFinished() { await startSession() }
    } else {
        stateLock.lock(); finished = true; stateLock.unlock()
        var output: [String: Any] = ["t": "final", "v": text, "gen": gen, "emittedAt": ProcessInfo.processInfo.systemUptime]
        if let (from, to) = audioRange { output["audioStartAt"] = from; output["audioEndAt"] = to }
        emit(output)
        teardown()
        emit(["t": "end"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { exitASR(0) }
    }
}

/// 判定这句说完了：让 analyzer 吐 final，结果流里会走 endSession
func beginEnd(_ reason: String = "unspecified", expectedGen: Int? = nil) {
    stateLock.lock()
    if let expectedGen, expectedGen != sessionGen { stateLock.unlock(); return }
    if ending || finished || starting { stateLock.unlock(); return }
    if reason == "checkpoint" && sessionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { stateLock.unlock(); return }
    if reason == "quiet" && endpointPolicy.decision(at: ProcessInfo.processInfo.systemUptime, generation: sessionGen) != .quiet { stateLock.unlock(); return }
    let an = analyzer
    let gen = sessionGen
    let continuation = inputCont
    guard finalizationBarrier.request(at: ProcessInfo.processInfo.systemUptime, generation: gen) else { stateLock.unlock(); return }
    finalizedActivitySequence = activityOutputSequence
    ending = true
    let activityAtEnd = endpointPolicy.evidence(at: ProcessInfo.processInfo.systemUptime, generation: gen)
    inputCont = nil
    var traceMetadata = speechTraceEnabled ? speechTraceStateLocked(gen: gen) : nil
    if speechTraceEnabled { traceMetadata?.merge(["confirmed": sessionTranscript.confirmed, "combinedChars": sessionText.count]) { _, next in next } }
    stateLock.unlock()
    speechDiagnostic?.record("endpoint", ["gen": gen, "reason": reason, "activity": activityAtEnd.rawValue])
    continuation?.finish()
    if let metadata = traceMetadata { traceSpeech(.finishStart, metadata) }

    Task {
        do {
            guard let an else { throw NSError(domain: "bunny.speech-finalization", code: 1) }
            try await an.finalizeAndFinishThroughEndOfInput()
            stateLock.lock()
            if gen == sessionGen && !finished { finalizationBarrier.finalizerSucceeded(generation: gen) }
            stateLock.unlock()
            speechDiagnostic?.record("finish-return", ["gen": gen, "ok": true])
            traceSpeechState(.finishReturn, gen: gen, fields: ["ok": true])
            await publishFinalizedSession(gen: gen)
        }
        catch {
            speechDiagnostic?.record("finish-return", ["gen": gen, "ok": false])
            traceSpeechState(.finishReturn, gen: gen, fields: ["ok": false])
            stateLock.lock(); let live = gen == sessionGen && !finished
            if live { finalizationBarrier.fail(.finalizer, generation: gen) }; stateLock.unlock()
            if live { fail("语音定稿失败，未提交未确认的句子，请重新说出完整要求", code: 24) }
        }
    }
    Task {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        stateLock.lock(); let still = gen == sessionGen && ending && !finished && !finalizationBarrier.claimed
        if still { finalizationBarrier.timeout(generation: gen) }; stateLock.unlock()
        if still { fail("语音定稿超时，未提交未确认的句子，请重新说出完整要求", code: 24) }
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
    exitASR(0)
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
    if (statusOnly && !askMic) || hasFlag("--no-mic-ask") || speechDiagnostic != nil {
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
        exitASR(3)
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
        if speechDiagnostic != nil { fail("私有语音诊断所需语言资源未安装，未下载或启动识别", code: 47) }
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
    // 主程序统一请求回声消除；不支持的设备在启动时自动退回普通输入，
    // 不要求用户配置，也不根据某一台开发机的结果关闭所有 Mac 的能力。
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
                emit(["t": "mic", "on": true, "name": p.1, "id": Int(p.0), "identity": SpeakerFeatures.inputIdentity(engine.inputNode)])
            } else {
                emit(["t": "mic", "on": false, "name": "", "id": 0, "v": "使用系统默认输入设备", "identity": SpeakerFeatures.inputIdentity(engine.inputNode)])
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
            endpointPolicy.resetActivity(at: ProcessInfo.processInfo.systemUptime, generation: sessionGen)
            stateLock.unlock()
            emit(["t": "warn", "v": "闭麦超过 25 秒，自动开麦（上层漏了 unmute）"])
            lastChangeAt = Date()
            return
        }
        let m = muted
        let now = ProcessInfo.processInfo.systemUptime
        let gen = sessionGen
        let decision = endpointPolicy.decision(at: now, generation: gen)
        let vadUnavailable = now - endpointPolicy.healthAt >= endpointPolicy.vadHealthTimeoutSeconds
        let endingNow = ending || starting
        stateLock.unlock()
        if m || endingNow { return }
        if !alwaysMode && Date().timeIntervalSince(startedAt) > maxSeconds {
            abortUnconfirmedSession(gen: gen, reason: "capture-max-duration"); return
        }
        switch decision {
        case .quiet: beginEnd("quiet", expectedGen: gen)
        case .unconfirmed: abortUnconfirmedSession(gen: gen, reason: vadUnavailable ? "activity-unavailable" : "max-duration")
        case .wait: break
        }
    }
    sessionTimer = timer
    timer.resume()
}

// ---------------------------------------------------------------- 入口

func selftestEndpointNotifications() throws -> [String: Any] {
    var checks = 0, jobs: [() -> Void] = [], handled: [Int] = [], yielded = false
    func check(_ value: Bool) throws { checks += 1; if !value { throw NSError(domain: "bunny.speech-notification-selftest", code: checks) } }
    enqueueEndpointNotification = { jobs.append($0) }
    handleQuietEndpoint = { gen in if yielded { handled.append(gen) } }
    defer { endpointNotifications.close(); finished = true }
    func prepare(_ gen: Int) {
        let now = ProcessInfo.processInfo.systemUptime
        sessionGen = gen; finished = false; ending = false; starting = false
        endpointPolicy = SpeechEndpointPolicy(generation: gen, silenceMs: 900, maxSeconds: 45, startedAt: now - 3)
        endpointPolicy.recordText("fixture text", at: now - 2, generation: gen)
        endpointPolicy.observe(.active, quietSeconds: 0, at: now - 1.3, generation: gen, now: now - 1.3)
        endpointPolicy.observe(.quiet, quietSeconds: 1, at: now - 0.1, generation: gen, now: now - 0.1)
        endpointNotifications.reset(generation: gen)
    }
    prepare(7)
    stateLock.lock(); requestQuietEndpointLocked(gen: 7); requestQuietEndpointLocked(gen: 7)
    let coalesced = jobs.count == 1 && handled.isEmpty
    // The caller's yield occurs while it still owns the routing lock.
    yielded = true; stateLock.unlock(); try check(coalesced)
    let once = jobs.removeFirst(); once(); once(); try check(handled == [7])
    prepare(8); stateLock.lock(); requestQuietEndpointLocked(gen: 8)
    let now = ProcessInfo.processInfo.systemUptime
    endpointPolicy.observe(.active, quietSeconds: 0, at: now, generation: 8, now: now)
    stateLock.unlock(); jobs.removeFirst()(); try check(handled == [7])
    prepare(9); stateLock.lock(); requestQuietEndpointLocked(gen: 9); stateLock.unlock()
    let old = jobs.removeFirst()
    prepare(10); stateLock.lock(); requestQuietEndpointLocked(gen: 10); stateLock.unlock()
    old(); stateLock.lock(); requestQuietEndpointLocked(gen: 10); stateLock.unlock()
    try check(jobs.count == 1 && handled == [7]); jobs.removeFirst()(); try check(handled == [7,10])
    prepare(11); stateLock.lock(); requestQuietEndpointLocked(gen: 11); finished = true; endpointNotifications.close(); stateLock.unlock()
    jobs.removeFirst()(); try check(handled == [7,10])
    // A real-shaped 96ms eligible interval falls between two 150ms polls.
    var narrow = SpeechEndpointPolicy(generation: 12, silenceMs: 900, maxSeconds: 45, startedAt: 0)
    narrow.recordText("fixture text", at: 16.5896, generation: 12)
    narrow.observe(.active, quietSeconds: 0, at: 17.4669, generation: 12, now: 17.4669)
    narrow.observe(.quiet, quietSeconds: 0.85, at: 18.3606, generation: 12, now: 18.3676)
    try check(narrow.decision(at: 18.4294, generation: 12) == .wait)
    narrow.observe(.quiet, quietSeconds: 0.94, at: 18.4712, generation: 12, now: 18.4736)
    try check(narrow.decision(at: 18.4736, generation: 12) == .quiet)
    var notification = SpeechEndpointNotifications(); notification.reset(generation: 12)
    let eventTicket = notification.request(generation: 12)!
    try check(notification.claim(eventTicket, generation: 12))
    narrow.observe(.active, quietSeconds: 0, at: 18.5665, generation: 12, now: 18.5697)
    try check(narrow.decision(at: 18.5794, generation: 12) == .wait)
    // Exercise the actual stdout emitter without starting capture or analysis.
    prepare(50)
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!; buffer.frameLength = 160
    for i in 0..<160 { buffer.int16ChannelData![0][i] = 0 }
    stateLock.lock(); observeDeliveredAudioLocked(buffer, gen: 50, at: ProcessInfo.processInfo.systemUptime, seq: nil, route: "direct"); stateLock.unlock()
    prepare(51)
    stateLock.lock(); observeDeliveredAudioLocked(buffer, gen: 50, at: ProcessInfo.processInfo.systemUptime, seq: nil, route: "direct"); stateLock.unlock()
    stateLock.lock(); observeDeliveredAudioLocked(buffer, gen: 51, at: ProcessInfo.processInfo.systemUptime, seq: nil, route: "direct"); stateLock.unlock()
    return ["t":"selfTest", "speechEndpointNotifications":true, "narrowWindow":true, "coalesced":true,
            "sameGenerationCancellation":true, "generationIsolation":true, "yieldBeforeHandler":true, "closedLateJob":true,
            "checks":checks, "recognizerStarted":false]
}

@main struct ASRMain {
static func main() {
    if hasFlag("--self-test-short-final") {
        emitTranscriptUpdate("好", gen: 7, audioRange: (1, 2), retracting: false)
        emitUtterance("好", traceGen: 7, audioRange: (1, 2))
        emit(["t":"selfTest", "shortFinal":true, "recognizerStarted":false]); return
    }
    if hasFlag("--self-test-transcript-retract") {
        emitTranscriptUpdate("fixture provisional", gen: 7, audioRange: (1, 2), retracting: false)
        emitTranscriptUpdate("", gen: 7, audioRange: nil, retracting: true)
        emitTranscriptUpdate("", gen: 7, audioRange: nil, retracting: false)
        emit(["t":"selfTest", "transcriptRetraction":true, "recognizerStarted":false]); return
    }
    if hasFlag("--self-test-acoustic-evidence") {
        var evidence = SpeechAcousticEvidence(), transcript = SpeechTranscript()
        evidence.append(seconds: 2, capturedAt: 12, classified: [SpeechAcousticFrame(start: 0, end: 2, active: false)])
        guard !evidence.supports(start: 0, end: 1), !evidence.supports(start: 0, end: 0),
              !evidence.supports(start: .nan, end: 1) else { fail("静音或无效范围冒充人声", code: 1) }
        evidence.append(seconds: 0.1, capturedAt: 12.1, classified: [SpeechAcousticFrame(start: 0, end: 0.03, active: true), SpeechAcousticFrame(start: 0.03, end: 0.1, active: false)])
        guard !evidence.supports(start: 2, end: 2.1) else { fail("单帧瞬态冒充人声", code: 1) }
        evidence.append(seconds: 0.1, capturedAt: 12.2, classified: [SpeechAcousticFrame(start: 0, end: 0.1, active: true)])
        guard evidence.supports(start: 2.1, end: 2.2), !evidence.supports(start: 0, end: 2),
              !evidence.supports(start: 2.19, end: 2.21), !evidence.supports(start: 3, end: 4),
              let range = evidence.captureRange(start: 2.1, end: 2.2), abs(range.0 - 12.1) < 0.000001,
              abs(range.1 - 12.2) < 0.000001 else { fail("声学范围归属不正确", code: 1) }
        let supported = evidence.supports(start: 2.1, end: 2.2)
        transcript.accept(text: supported ? "真实短指令" : "", start: 2.1, end: 2.2, finalizedThrough: 2.2)
        transcript.accept(text: evidence.supports(start: 0, end: 1) ? "任意幻觉词" : "", start: 0, end: 1, finalizedThrough: 2.2)
        guard transcript.text == "真实短指令", transcript.confirmed else { fail("识别范围未隔离静音与真实人声", code: 1) }
        var unknown = SpeechAcousticEvidence()
        unknown.append(seconds: 1, capturedAt: 11, classified: [])
        guard !unknown.supports(start: 0, end: 1) else { fail("未知音频冒充人声", code: 1) }
        // The previous buffer's uncompleted 10ms frame can be classified by
        // its successor. Keep that sample range, but never cross a new gen.
        unknown.append(seconds: 0.1, capturedAt: 11.1, classified: [SpeechAcousticFrame(start: -0.005, end: 0.065, active: true)])
        guard unknown.supports(start: 0.995, end: 1.035) else { fail("跨缓冲帧证据丢失", code: 1) }
        var successor = SpeechAcousticEvidence()
        successor.append(seconds: 0.1, capturedAt: 11.2, classified: [SpeechAcousticFrame(start: -0.005, end: 0.01, active: true)])
        guard !successor.supports(start: 0, end: 0.1) else { fail("旧代部分帧污染新代", code: 1) }
        emit(["t":"selfTest", "acousticEvidence":true, "quietRejected":true, "unknownRejected":true,
              "transientRejected":true, "rangeOwnership":true, "captureClock":true, "realSpeechPreserved":true,
              "partialFrameOwnership":true, "recognizerStarted":false]); return
    }
    if hasFlag("--self-test-empty-audio-final") {
        Task {
            sessionGen = 7; ending = true; finished = false
            activityOutputSequence = 99; finalizedActivitySequence = 42
            finalizationBarrier = SpeechFinalizationBarrier(generation: 7)
            finalizationBarrier.request(at: 1, generation: 7)
            finalizationBarrier.resultsEnded(confirmed: true, text: "", generation: 7)
            await publishFinalizedSession(gen: 7)
            guard sessionGen == 7 else { fail("空音频未等收尾成功即上报", code: 1) }
            finalizationBarrier.finalizerSucceeded(generation: 7)
            await publishFinalizedSession(gen: 7)
            await publishFinalizedSession(gen: 7)
            guard sessionGen == 8 else { fail("空音频收尾未一次性完成", code: 1) }
            emit(["t":"selfTest", "emptyAudioFinal":true, "barrierRequired":true,
                  "exactCoverage":true, "onceOnly":true, "recognizerStarted":false])
        }
        RunLoop.main.run(); return
    }
    if hasFlag("--self-test-speech-endpoint-notifications") {
        do { emit(try selftestEndpointNotifications()); return }
        catch { fail("语音端点事件通知离线夹具失败", code: 1) }
    }
    if hasFlag("--self-test-speech-endpoint-driver") {
        let now = ProcessInfo.processInfo.systemUptime
        sessionGen = 7; ending = false; finished = false; starting = false
        endpointPolicy = SpeechEndpointPolicy(generation: 7, silenceMs: 900, maxSeconds: 45, startedAt: now - 3)
        endpointPolicy.recordText("fixture text", at: now - 2, generation: 7)
        endpointPolicy.observe(.active, quietSeconds: 0, at: now - 1.3, generation: 7, now: now - 1.3)
        endpointPolicy.observe(.quiet, quietSeconds: 1, at: now - 0.1, generation: 7, now: now - 0.1)
        guard endpointPolicy.decision(at: now, generation: 7) == .quiet else { fail("端点接线夹具未准备", code: 1) }
        // A new active frame invalidates a timer decision in the same gen.
        endpointPolicy.observe(.active, quietSeconds: 0, at: now, generation: 7, now: now)
        beginEnd("quiet", expectedGen: 7)
        beginEnd("checkpoint", expectedGen: 7)
        beginEnd("checkpoint", expectedGen: 9) // Empty text has no checkpoint authority.
        guard !ending && !finished else { fail("旧静音判断未被新语音撤销", code: 1) }
        sessionGen = 9
        endpointPolicy = SpeechEndpointPolicy(generation: 9, silenceMs: 900, maxSeconds: 45, startedAt: now)
        finalizationBarrier = SpeechFinalizationBarrier(generation: 9)
        beginEnd("quiet", expectedGen: 7)
        abortUnconfirmedSession(gen: 7, reason: "activity-unavailable")
        abortUnconfirmedSession(gen: 9, reason: "activity-unavailable")
        guard !ending && !finished && finalizationBarrier.requestedAt == nil else { fail("旧代或旧故障判断影响新识别", code: 1) }
        // A short utterance captured during an old finalizer must supply
        // acoustic evidence to the new generation that actually receives it.
        let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
        let voiced = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1600)!
        voiced.frameLength = 1600
        for index in 0..<1600 { voiced.int16ChannelData![0][index] = Int16(truncatingIfNeeded: index * index) }
        inputCont = nil; enqueueAudio(voiced)
        guard pendingAudio.count == 1 && !endpointPolicy.hasObservedActive else { fail("排队音频证据归属错误", code: 1) }
        sessionGen = 11
        endpointPolicy = SpeechEndpointPolicy(generation: 11, silenceMs: 900, maxSeconds: 45)
        let queued = pendingAudio[0], capturedAt = pendingAudioTimes[ObjectIdentifier(queued)]!
        stateLock.lock(); observeDeliveredAudioLocked(queued, gen: 11, at: capturedAt, seq: nil, route: "replay"); stateLock.unlock()
        guard endpointPolicy.hasObservedActive else { fail("新识别未继承其实际排队音频的活动证据", code: 1) }
        pendingAudio.removeAll(); pendingAudioTimes.removeAll(); pendingAudioSeconds = 0
        emit(["t": "selfTest", "speechEndpointDriver": true, "sameGenerationRecheck": true,
              "generationIsolation": true, "healthRecheck": true, "queuedEvidenceOwnership": true, "recognizerStarted": false]); return
    }
    if hasFlag("--self-test-unconfirmed-abort") {
        sessionGen = 7; ending = false; finished = false
        endpointPolicy = SpeechEndpointPolicy(generation: 7, silenceMs: 900, maxSeconds: 45,
            startedAt: ProcessInfo.processInfo.systemUptime - 5)
        finalizationBarrier = SpeechFinalizationBarrier(generation: 7)
        abortUnconfirmedSession(gen: 7, reason: "activity-unavailable")
        fail("未能取消无证据识别", code: 1)
    }
    if hasFlag("--self-test-speech-endpoint") {
        do { emit(try SpeechEndpointPolicy.selfTest()); return }
        catch { fail("语音端点离线夹具失败", code: 1) }
    }
    if hasFlag("--self-test-speech-activity") {
        emit(selftestSpeechActivity()); return
    }
    if hasFlag("--self-test-speech-diagnostic") {
        do { emit(try SpeechDiagnostic.selfTest()); return }
        catch { emit(["t": "selfTestFailure", "stage": (error as NSError).code, "failure": (error as? SpeechDiagnostic.Failure).map { String(describing: $0) } ?? "assertion"]); fail("私有语音诊断离线夹具失败", code: 1) }
    }
    if CommandLine.arguments.contains("--self-test-transcript") {
        var transcript = SpeechTranscript()
        transcript.accept(text: "请制作", start: 0, end: 1, finalizedThrough: 0)
        transcript.accept(text: "请制作网站。", start: 0, end: 2, finalizedThrough: 2)
        transcript.accept(text: "并添加", start: 2, end: 3, finalizedThrough: 2)
        transcript.accept(text: "并添加种植日历。", start: 2, end: 4, finalizedThrough: 4)
        transcript.accept(text: "不要发布。", start: 4, end: 5, finalizedThrough: 4)
        guard transcript.text == "请制作网站。并添加种植日历。不要发布。", !transcript.confirmed else {
            fail("片段定稿或修订丢失前文", code: 1)
        }
        // Advancing finalization can confirm unchanged volatile text without
        // another copy of that result.
        transcript.accept(text: "", start: 5, end: 5, finalizedThrough: 5)
        guard transcript.confirmed else { fail("未处理定稿时间推进", code: 1) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 160)!
        for frame in 0..<160 { buffer.floatChannelData![0][frame] = 0.25 }
        buffer.frameLength = 160; buffer.floatChannelData![0][0] = 0.75
        enqueueAudio(buffer); buffer.floatChannelData![0][0] = 0.25; enqueueAudio(buffer)
        guard pendingAudio.count == 2, pendingAudio[0].floatChannelData![0][0] == 0.75,
              pendingAudio[1].floatChannelData![0][0] == 0.25 else { fail("切句音频顺序或拷贝错误", code: 1) }
        if speechTraceEnabled {
            // Pure range/metadata fixtures: this path never starts an engine,
            // constructs a SpeechAnalyzer or requests microphone/assets.
            var plain = SpeechTranscript(), observed = SpeechTranscript()
            plain.accept(text: "private-trace-canary", start: 0, end: 1, finalizedThrough: 1)
            observed.accept(text: "private-trace-canary", start: 0, end: 1, finalizedThrough: 1)
            plain.accept(text: "replacement", start: 0.999999, end: 2, finalizedThrough: 2)
            let observation = observed.accept(text: "replacement", start: 0.999999, end: 2, finalizedThrough: 2, observing: true)
            let levels = speechTraceLevels(buffer)
            guard plain.text == observed.text, plain.confirmed == observed.confirmed,
                  observation?.removedSegments == 1, observation?.touchesFinalized == true,
                  (levels["rms"] as? [Double]) == [0.25], (levels["peak"] as? [Double]) == [0.25],
                  speechTraceRecord(.result, ["textChars": 1], enabled: false) == nil,
                  let safe = speechTraceRecord(.result, ["text": "private-trace-canary", "deviceUID": "private-trace-canary", "frames": "123", "start": Double.nan, "rms": [Double.infinity], "peak": [true], "isFinal": true], enabled: true),
                  safe["text"] == nil, safe["deviceUID"] == nil, safe["frames"] == nil, safe["start"] == nil, safe["rms"] == nil, safe["peak"] == nil else {
                fail("语音诊断改变聚合或包含非数值字段", code: 1)
            }
            for stage in SpeechTraceStage.allCases {
                var metadata = levels
                metadata.merge([
                    "start": 0.999999, "end": 2, "finalizedThrough": 2, "isFinal": true, "textChars": observed.text.count,
                    "combinedChars": observed.text.count, "removedSegments": observation!.removedSegments,
                    "touchesFinalized": observation!.touchesFinalized, "confirmed": observed.confirmed,
                    "text": "private-trace-canary", "deviceUID": "private-trace-canary"]) { _, next in next }
                traceSpeechState(stage, gen: 7, fields: metadata)
            }
        }
        emit(["t":"selfTest", "transcriptRanges":true, "rolloverAudio":true]); return
    }
    if CommandLine.arguments.contains("--wake-name-test") { emit(WakeName.selfTest()); return }
    if CommandLine.arguments.contains("--voice-feature-test") { SpeakerFeatures.selfTest(emit); return }
    if hasFlag("--speech-diagnostic-dir") {
        guard let ms = Int(argValue("--speech-diagnostic-ms", "20000")), (1...20000).contains(ms),
              !statusOnly, !listMics, !hasFlag("--probe-all") else { fail("私有语音诊断参数不合法", code: 40) }
        // Arm before opening files as well as before any device/asset work.
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms)) {
            // No ASR/writer lock may delay this final process deadline.
            Darwin._exit(48)
        }
        do {
            speechDiagnostic = try SpeechDiagnostic(directory: argValue("--speech-diagnostic-dir", ""), durationMs: ms, pcm: hasFlag("--speech-diagnostic-pcm"), onStop: endSpeechDiagnostic)
        } catch { fail("私有语音诊断目录或文件不安全，未启动采集", code: 41) }
    } else if hasFlag("--speech-diagnostic-pcm") || hasFlag("--speech-diagnostic-ms") {
        fail("私有语音诊断缺少专用目录", code: 40)
    }
// 只枚举设备：不采集、不弹窗，可以随便从命令行跑
if listMics {
    let devs = listInputDevices()
    emit(["t": "mics", "v": devs.map { ["id": Int($0.0), "name": $0.1, "ch": $0.2] }])
    emit(["t": "end"])
    exitASR(0)
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
        case let checkpoint where checkpoint.hasPrefix("checkpoint "):
            if alwaysMode, let gen = Int(checkpoint.dropFirst("checkpoint ".count)), gen >= 0 {
                beginEnd("checkpoint", expectedGen: gen)
            }
        case "stop":
            if isFinished() { continue }
            beginEnd("stdin-stop")
            return
        case "quit":
            if speechDiagnostic != nil { endSpeechDiagnostic(0); return }
            exitASR(0)
        case "mute":
            stateLock.lock(); muted = true; mutedAt = Date(); stateLock.unlock()
        case "unmute":
            stateLock.lock(); muted = false; mutedAt = nil; lastChangeAt = Date()
            endpointPolicy.resetActivity(at: ProcessInfo.processInfo.systemUptime, generation: sessionGen); stateLock.unlock()
        default:
            break
        }
    }
    // stdin 断了 = 父进程没了。不留孤儿进程（--status 例外：它不读 stdin，随时会自己退）
    if !statusOnly { if speechDiagnostic != nil { endSpeechDiagnostic(0); return }; exitASR(0) }
}

// 父进程看门狗：父进程一死，我们立刻跟着退，避免用户"退出了但麦克风还占着"
let parentPid = getppid()
let parentWatch = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
parentWatch.schedule(deadline: .now() + 3, repeating: 3)
parentWatch.setEventHandler {
    if getppid() != parentPid || getppid() == 1 { exitASR(0) }
}
parentWatch.resume()

// 兜底
if statusOnly {
    DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
        emit(["t": "error", "v": "查询语音状态超时", "code": 10])
        emit(["t": "end"])
        exitASR(0)
    }
} else if !alwaysMode {
    DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds + 12) {
        if !isFinished() { beginEnd("process-watchdog") }
    }
}

RunLoop.main.run()

}
}
