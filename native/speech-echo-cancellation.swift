import Foundation
import AVFoundation
import CoreAudio
import AudioToolbox

// A private, unmuted tap supplies the actual mix sent to the speakers, including
// Electron's renderer and other applications. It never changes a default device,
// device volume, or the samples being played. No process enumeration is needed.
final class SystemAudioReference {
    struct Frame {
        let at: Double
        let left: [Float]
        let right: [Float]
    }
    struct Snapshot {
        let frames: [Frame]
        let epoch: Int
        let lastReceivedAt: Double
        let failure: Int32
    }
    private let control = DispatchQueue(label: "bunny.echo-reference.control")
    private let recovery = DispatchQueue(label: "bunny.echo-reference.recovery")
    private let audioQueue = DispatchQueue(label: "bunny.echo-reference.audio", qos: .userInteractive)
    private let lock = NSLock()
    private var frames: [Frame] = []
    private var epoch = 0
    private var receivedAt = 0.0
    private var failure: Int32 = 0
    private var stopped = false
    private var stopRequested = false
    private var startingAt = 0.0
    private var lastAttemptAt = 0.0
    private var restartQueued = false
    private var recoveryTimer: DispatchSourceTimer?
    private var tap = AudioObjectID(kAudioObjectUnknown)
    private var aggregate = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private var outputListener: AudioObjectPropertyListenerBlock?
    private var converter: AudioPCMStreamConverter?
    private var conversionEpoch = -1
    private var sourceFormat: AVAudioFormat?
    private let target = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private var left: [Float] = [], right: [Float] = []
    private var partialAt = 0.0

    fileprivate init(fixtureFormat: AVAudioFormat? = nil) {
        if let fixtureFormat {
            sourceFormat = fixtureFormat
            converter = AudioPCMStreamConverter(target: target)
        }
    }

    func start() {
        let timer = DispatchSource.makeTimerSource(queue: recovery)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.recoverIfNeeded() }
        recoveryTimer = timer; timer.resume()
        control.async { [self] in
            guard !stopped else { return }
            var address = Self.defaultOutputAddress
            let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                guard let self else { return }
                self.control.async { [self] in
                    guard !self.stopped else { return }
                    self.closeDevices(); self.openDevices()
                }
            }
            outputListener = listener
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, control, listener)
            openDevices()
        }
    }
    func stop() {
        lock.withLock { stopRequested = true }
        recoveryTimer?.cancel(); recoveryTimer = nil
        control.async { [self] in
            stopped = true
            if let listener = outputListener {
                var address = Self.defaultOutputAddress
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, control, listener)
                outputListener = nil
            }
            closeDevices()
        }
    }
    private func recoverIfNeeded() {
        let now = ProcessInfo.processInfo.systemUptime
        let retry = lock.withLock { () -> Bool in
            guard !stopRequested else { return false }
            if startingAt > 0 {
                // A system permission prompt/API can outlive our deadline.
                // Report that explicitly and never pile up more setup calls.
                if now - startingAt > 5 { failure = -8 }
                return false
            }
            guard !restartQueued, Self.recoveryDue(now: now, lastAttemptAt: lastAttemptAt,
                lastReceivedAt: receivedAt, failure: failure) else { return false }
            restartQueued = true; return true
        }
        if retry {
            control.async { [self] in
                guard !stopped, !lock.withLock({ stopRequested }) else { return }
                closeDevices(); openDevices()
            }
        }
    }
    fileprivate static func recoveryDue(now: Double, lastAttemptAt: Double,
                                        lastReceivedAt: Double, failure: Int32) -> Bool {
        // AudioDeviceStart can succeed without ever delivering an IOProc. That
        // first-callback deadline belongs to this stream, just like later stalls.
        now - lastAttemptAt >= 5 && failure != kAudioDevicePermissionsError &&
            (failure != 0 || lastReceivedAt == 0 || now - lastReceivedAt > 2)
    }
    private static var defaultOutputAddress: AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }
    private func invalidate(_ error: Int32) {
        lock.lock(); epoch += 1; frames.removeAll(keepingCapacity: true)
        receivedAt = 0; failure = error; lock.unlock()
    }
    private func closeDevices() {
        if aggregate != kAudioObjectUnknown {
            if let ioProc {
                AudioDeviceStop(aggregate, ioProc)
                AudioDeviceDestroyIOProcID(aggregate, ioProc)
            }
            AudioHardwareDestroyAggregateDevice(aggregate)
        }
        aggregate = AudioObjectID(kAudioObjectUnknown); ioProc = nil
        if tap != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tap) }
        tap = AudioObjectID(kAudioObjectUnknown)
        // IOProc is stopped before touching its converter and partial frame.
        converter = nil; sourceFormat = nil; left.removeAll(); right.removeAll(); conversionEpoch = -1
        invalidate(0)
    }
    private func openDevices() {
        lock.withLock { startingAt = ProcessInfo.processInfo.systemUptime; lastAttemptAt = startingAt; restartQueued = false }
        defer { lock.withLock { startingAt = 0 } }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.name = "WorkBunny speaker echo reference"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr else { invalidate(status); return }
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var stream = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &stream)
        guard status == noErr, let format = AVAudioFormat(streamDescription: &stream),
              format.sampleRate > 0, format.channelCount > 0, format.channelCount <= 32 else {
            closeDevices(); invalidate(status == noErr ? -2 : status); return
        }
        sourceFormat = format; converter = AudioPCMStreamConverter(target: target)
        // A tap-only private aggregate cannot accidentally include a USB
        // device's physical microphone as part of the speaker reference.
        let specification: [String: Any] = [
            kAudioAggregateDeviceNameKey: "WorkBunny echo reference",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString,
                                             kAudioSubTapDriftCompensationKey: true]],
            // Waiting for a tapped application to start output could otherwise
            // stall startup indefinitely when the computer is quiet.
            kAudioAggregateDeviceTapAutoStartKey: false
        ]
        status = AudioHardwareCreateAggregateDevice(specification as CFDictionary, &aggregate)
        guard status == noErr else { closeDevices(); invalidate(status); return }
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, audioQueue) { [weak self] _, input, inputTime, output, _ in
            let outputBuffers = UnsafeMutableAudioBufferListPointer(output)
            for buffer in outputBuffers { if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) } }
            self?.receive(input, time: inputTime.pointee)
        }
        guard status == noErr, let ioProc else { closeDevices(); invalidate(status == noErr ? -3 : status); return }
        // This may ask for system-audio permission. It runs independently of
        // microphone capture; refusal or a stalled prompt cannot close ears.
        status = AudioDeviceStart(aggregate, ioProc)
        guard status == noErr else { closeDevices(); invalidate(status); return }
    }
    private func receive(_ input: UnsafePointer<AudioBufferList>, time: AudioTimeStamp) {
        guard time.mFlags.contains(.hostTimeValid), let format = sourceFormat, let converter else { invalidate(-4); return }
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
        guard let first = source.first, format.streamDescription.pointee.mBytesPerFrame > 0 else { invalidate(-5); return }
        let count = Int(first.mDataByteSize) / Int(format.streamDescription.pointee.mBytesPerFrame)
        guard count > 0, Double(count) <= format.sampleRate * 0.5,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { invalidate(-5); return }
        buffer.frameLength = AVAudioFrameCount(count)
        let destination = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard source.count == destination.count else { invalidate(-5); return }
        for (from, to) in zip(source, destination) {
            guard let sourceData = from.mData, let targetData = to.mData,
                  from.mDataByteSize <= to.mDataByteSize else { invalidate(-5); return }
            memcpy(targetData, sourceData, Int(from.mDataByteSize))
        }
        let at = AVAudioTime.seconds(forHostTime: time.mHostTime)
        let converted: [AudioPCMChunk]
        do { converted = try converter.convert(buffer, at: at) }
        catch { invalidate(-6); return }
        if conversionEpoch != converter.epoch {
            conversionEpoch = converter.epoch
            left.removeAll(keepingCapacity: true); right.removeAll(keepingCapacity: true); invalidate(0)
        }
        var completed: [Frame] = []
        for chunk in converted {
            defer { withExtendedLifetime(chunk) {} }
            guard let channels = chunk.buffer.floatChannelData else { invalidate(-6); return }
            if left.isEmpty { partialAt = chunk.at }
            left.append(contentsOf: UnsafeBufferPointer(start: channels[0], count: Int(chunk.buffer.frameLength)))
            right.append(contentsOf: UnsafeBufferPointer(start: channels[1], count: Int(chunk.buffer.frameLength)))
            while left.count >= 480 {
                completed.append(Frame(at: partialAt, left: Array(left.prefix(480)), right: Array(right.prefix(480))))
                left.removeFirst(480); right.removeFirst(480); partialAt += 0.01
            }
        }
        lock.lock()
        frames.append(contentsOf: completed)
        if frames.count > 200 { frames.removeFirst(frames.count - 200); epoch += 1 }
        // Zero samples are a live, silent reference, not a failed reference.
        receivedAt = ProcessInfo.processInfo.systemUptime; failure = 0
        lock.unlock()
    }
    func take(through at: Double) -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        let end = frames.firstIndex { $0.at > at } ?? frames.count
        let available = Array(frames.prefix(end))
        if end > 0 { frames.removeFirst(end) }
        return Snapshot(frames: available, epoch: epoch, lastReceivedAt: receivedAt, failure: failure)
    }
    func state() -> Snapshot {
        lock.withLock { Snapshot(frames: [], epoch: epoch, lastReceivedAt: receivedAt, failure: failure) }
    }
    fileprivate func supplyFixture(_ buffer: AVAudioPCMBuffer, at: Double) {
        var time = AudioTimeStamp(); time.mHostTime = AVAudioTime.hostTime(forSeconds: at); time.mFlags = .hostTimeValid
        receive(UnsafePointer(buffer.audioBufferList), time: time)
    }
    fileprivate func ageFixture() { lock.withLock { receivedAt = ProcessInfo.processInfo.systemUptime - 0.5 } }
}

// Only the microphone callback owns the converters, partial capture frame and
// AEC context. The reference callback only writes the bounded timestamped ring.
final class SpeechEchoCancellation {
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    private let reference: SystemAudioReference
    private let conversion: AudioPCMStreamConverter
    private var conversionEpoch = -1
    private var context: OpaquePointer?
    private var partial: [Float] = []
    private var partialAt = 0.0
    private var referenceEpoch = -1
    private var ready = false
    private var lastState = ""
    private var lastCode = Int32.min
    private var newestRenderAt = 0.0
    private var newestRenderAnalyzedAt = 0.0
    private var lastBufferingDelayMs: Int32 = 0
    private var latestCaptureAt = 0.0, referenceRms = 0.0
    private let output: ([String: Any]) -> Void
    private let recordReference: ((AudioPCMChunk) -> Void)?
    private let captureHeadroomSeconds: Double

    init(sourceFormat: AVAudioFormat, reference: SystemAudioReference = SystemAudioReference(),
         startReference: Bool = true, captureHeadroomMs: Int = 60, recordReference: ((AudioPCMChunk) -> Void)? = nil,
         output: @escaping ([String: Any]) -> Void) {
        self.output = output; self.reference = reference; self.recordReference = recordReference
        captureHeadroomSeconds = Double(min(100, max(0, captureHeadroomMs))) / 1000
        conversion = AudioPCMStreamConverter(target: format)
        context = wb_aec_create(48000, 2)
        if startReference { reference.start() }
    }
    func stop() { reference.stop() }
    deinit { if let context { wb_aec_destroy(context) } }
    private func status(_ state: String, code: Int32 = 0) {
        guard state != lastState || code != lastCode else { return }; lastState = state; lastCode = code
        output(["t": "aec", "on": state == "active", "engine": "webrtc-aec3", "state": state,
                "referenceCode": Int(code), "systemDucking": false])
    }
    private func reset() {
        if let context { wb_aec_reset(context) }
        newestRenderAt = 0; newestRenderAnalyzedAt = 0; lastBufferingDelayMs = 0; ready = false
    }
    func diagnostics() -> [String: Any] {
        var result: [String: Any] = ["referenceRms": referenceRms, "referenceAt": newestRenderAt,
            "referenceLagMs": (latestCaptureAt - newestRenderAt) * 1000,
            "aecBufferingDelayMs": Int(lastBufferingDelayMs),
            "captureHeadroomMs": captureHeadroomSeconds * 1000, "capturePendingFrames": partial.count]
        if let context {
            var stats = WBAECStats()
            if wb_aec_get_stats(context, &stats) == 0 {
                result.merge(["aecRenderFrames": stats.render_frames, "aecCaptureFrames": stats.capture_frames,
                    "aecResets": stats.resets, "aecDelayMs": stats.estimated_delay_ms,
                    "aecErleDb": stats.echo_return_loss_enhancement_db]) { _, next in next }
            }
        }
        return result
    }
    fileprivate static func bufferingDelayMs(renderAt: Double, analyzedAt: Double,
                                             captureAt: Double, processedAt: Double) -> Int32 {
        // WebRTC's buffering delay is (t_render - t_analyze) +
        // (t_process - t_capture), not the acoustic path estimate. Both PCM
        // timestamps label their first sample on the host clock. Render and
        // capture run serially here, but keep their actual call-time difference.
        let seconds = (renderAt - analyzedAt) + (processedAt - captureAt)
        return Int32(min(500, max(0, (seconds * 1000).rounded())))
    }
    func process(_ input: AVAudioPCMBuffer, at audioTime: AVAudioTime) -> AVAudioPCMBuffer? {
        processChunk(input, at: audioTime)?.buffer
    }
    func processChunk(_ input: AVAudioPCMBuffer, at audioTime: AVAudioTime) -> AudioPCMChunk? {
        guard audioTime.isHostTimeValid else { status("degraded", code: -4); return AudioPCMChunk(buffer: input, at: ProcessInfo.processInfo.systemUptime - Double(input.frameLength) / input.format.sampleRate) }
        let at = AVAudioTime.seconds(forHostTime: audioTime.hostTime)
        let mono: [AudioPCMChunk]
        do { mono = try conversion.convert(input, at: at) }
        catch { status("degraded", code: -6); return AudioPCMChunk(buffer: input, at: at) }
        if conversionEpoch != conversion.epoch {
            conversionEpoch = conversion.epoch; partial.removeAll(keepingCapacity: true); reset()
        }
        return processMono(mono)
    }
    private func processMono(_ chunks: [AudioPCMChunk], flushing: Bool = false) -> AudioPCMChunk? {
        for mono in chunks {
            defer { withExtendedLifetime(mono) {} }
            guard let source = mono.buffer.floatChannelData?[0] else { status("degraded", code: -6); return nil }
            if partial.isEmpty { partialAt = mono.at }
            partial.append(contentsOf: UnsafeBufferPointer(start: source, count: Int(mono.buffer.frameLength)))
        }
        let health = reference.state()
        let referenceLive = health.failure == 0 && health.lastReceivedAt > 0 &&
            ProcessInfo.processInfo.systemUptime - health.lastReceivedAt <= 0.25 && context != nil
        // Core Audio's tap timestamp can lag part of the acoustic path. Keep
        // a bounded amount of near-end PCM so that the corresponding render
        // samples can be supplied first. Capture tags remain unchanged.
        // A failed reference releases this queue as raw input immediately.
        let held = referenceLive && !flushing ? Int((captureHeadroomSeconds * 48000).rounded()) : 0
        let count = max(0, partial.count - held) / 480 * 480
        guard count > 0, let processed = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return nil }
        processed.frameLength = AVAudioFrameCount(count)
        let destination = processed.floatChannelData![0]
        for offset in stride(from: 0, to: count, by: 480) {
            let captureAt = partialAt + Double(offset) / 48000
            latestCaptureAt = captureAt
            let snapshot = reference.take(through: captureAt + captureHeadroomSeconds + 0.01)
            if snapshot.epoch != referenceEpoch { referenceEpoch = snapshot.epoch; reset() }
            let live = snapshot.lastReceivedAt > 0 && ProcessInfo.processInfo.systemUptime - snapshot.lastReceivedAt <= 0.25 && snapshot.failure == 0
            var valid = live && context != nil
            var failure = snapshot.failure != 0 ? snapshot.failure : (!live ? -7 : (context == nil ? Int32(WB_AEC_NOT_INITIALIZED) : 0))
            if let context, valid {
                for frame in snapshot.frames where captureAt - frame.at <= 0.25 {
                    if let recordReference, let pcm = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!, frameCapacity: 480) {
                        pcm.frameLength = 480
                        frame.left.withUnsafeBufferPointer { pcm.floatChannelData![0].update(from: $0.baseAddress!, count: 480) }
                        frame.right.withUnsafeBufferPointer { pcm.floatChannelData![1].update(from: $0.baseAddress!, count: 480) }
                        recordReference(AudioPCMChunk(buffer: pcm, at: frame.at))
                    }
                    let analyzedAt = ProcessInfo.processInfo.systemUptime
                    let result = frame.left.withUnsafeBufferPointer { left in
                        frame.right.withUnsafeBufferPointer { right in
                            var channels: [UnsafePointer<Float>?] = [left.baseAddress, right.baseAddress]
                            return channels.withUnsafeMutableBufferPointer { wb_aec_process_render(context, $0.baseAddress, 480) }
                        }
                    }
                    if result != 0 { valid = false; failure = result; break }
                    referenceRms = sqrt(zip(frame.left, frame.right).reduce(0.0) { $0 + (Double($1.0) * Double($1.0) + Double($1.1) * Double($1.1)) / 960 })
                    newestRenderAt = frame.at; newestRenderAnalyzedAt = analyzedAt; ready = true
                }
                valid = valid && ready && newestRenderAt <= captureAt + captureHeadroomSeconds + 0.05 && captureAt - newestRenderAt <= 0.25
                if valid {
                    let delay = Self.bufferingDelayMs(renderAt: newestRenderAt, analyzedAt: newestRenderAnalyzedAt,
                        captureAt: captureAt, processedAt: ProcessInfo.processInfo.systemUptime)
                    lastBufferingDelayMs = delay
                    let delayStatus = wb_aec_set_stream_delay_ms(context, delay)
                    let result = partial.withUnsafeBufferPointer { wb_aec_process_capture(context, $0.baseAddress!.advanced(by: offset), destination.advanced(by: offset), 480) }
                    valid = result == 0 && delayStatus == 0
                    if !valid { failure = result != 0 ? result : delayStatus }
                }
            }
            if valid { status("active") }
            else {
                partial.withUnsafeBufferPointer { destination.advanced(by: offset).update(from: $0.baseAddress!.advanced(by: offset), count: 480) }
                if ready { reset() }
                status("degraded", code: failure)
            }
        }
        let result = AudioPCMChunk(buffer: processed, at: partialAt)
        partial.removeFirst(count); partialAt += Double(count) / 48000
        return result
    }
    func flush() throws -> [AudioPCMChunk] {
        var result: [AudioPCMChunk] = []
        if let full = processMono(try conversion.flush(), flushing: true) { result.append(full) }
        // AEC3 requires a full 10ms frame. Preserve the final short tail without
        // inventing zero samples or allowing it to authenticate a whole word.
        if !partial.isEmpty, let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(partial.count)) {
            tail.frameLength = AVAudioFrameCount(partial.count)
            partial.withUnsafeBufferPointer { tail.floatChannelData![0].update(from: $0.baseAddress!, count: $0.count) }
            result.append(AudioPCMChunk(buffer: tail, at: partialAt)); partial.removeAll()
        }
        return result
    }

    static func selfTest() throws -> [String: Any] {
        var checks = 0
        func check(_ condition: Bool) throws {
            checks += 1
            if !condition { throw NSError(domain: "bunny.echo-routing.self-test", code: checks) }
        }
        try check(bufferingDelayMs(renderAt: 10.05, analyzedAt: 10.2, captureAt: 10, processedAt: 10.2) == 50)
        try check(bufferingDelayMs(renderAt: 9.95, analyzedAt: 10.2, captureAt: 10, processedAt: 10.2) == 0)
        try check(bufferingDelayMs(renderAt: 10, analyzedAt: 10.2, captureAt: 10, processedAt: 10.2) == 0)
        try check(bufferingDelayMs(renderAt: 10.05, analyzedAt: 10.2, captureAt: 10, processedAt: 10.212) == 62)
        try check(bufferingDelayMs(renderAt: 11, analyzedAt: 11.1, captureAt: 10, processedAt: 11.1) == 500)
        try check(!SystemAudioReference.recoveryDue(now: 14.9, lastAttemptAt: 10, lastReceivedAt: 0, failure: 0))
        try check(SystemAudioReference.recoveryDue(now: 15, lastAttemptAt: 10, lastReceivedAt: 0, failure: 0))
        try check(!SystemAudioReference.recoveryDue(now: 15, lastAttemptAt: 10, lastReceivedAt: 14.9, failure: 0))
        try check(SystemAudioReference.recoveryDue(now: 15, lastAttemptAt: 10, lastReceivedAt: 12, failure: 0))
        try check(!SystemAudioReference.recoveryDue(now: 15, lastAttemptAt: 10, lastReceivedAt: 0, failure: kAudioDevicePermissionsError))
        let mono = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let stereo = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
        func pcm(_ format: AVAudioFormat, frames: Int, sample: Float = 0) -> AVAudioPCMBuffer {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
            buffer.frameLength = AVAudioFrameCount(frames)
            for channel in 0..<Int(format.channelCount) {
                buffer.floatChannelData![channel].update(repeating: sample, count: frames)
            }
            return buffer
        }
        let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
        let ring = SystemAudioReference(fixtureFormat: stereo)
        let samples = pcm(stereo, frames: 1440)
        samples.floatChannelData![0][0] = 0.25; samples.floatChannelData![1][0] = -0.5
        ring.supplyFixture(samples, at: now)
        let first = ring.take(through: now + 0.005)
        try check(first.frames.count == 1 && first.frames[0].left[0] == 0.25 && first.frames[0].right[0] == -0.5)
        try check(ring.take(through: now + 0.015).frames.count == 1)
        try check(ring.take(through: now + 0.1).frames.count == 1)
        for index in 0..<6 { ring.supplyFixture(pcm(stereo, frames: 24000), at: now + 1 + Double(index) * 0.5) }
        let bounded = ring.take(through: now + 10)
        try check(bounded.frames.count == 200 && bounded.epoch > first.epoch)

        var states: [[String: Any]] = []
        let liveReference = SystemAudioReference(fixtureFormat: stereo)
        let route = SpeechEchoCancellation(sourceFormat: mono, reference: liveReference, startReference: false, captureHeadroomMs: 0) { states.append($0) }
        let input = pcm(mono, frames: 480, sample: 0.125)
        let firstTime = AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: now))
        let raw = route.process(input, at: firstTime)
        try check(raw?.frameLength == 480 && raw!.floatChannelData![0][0] == 0.125 && states.last?["on"] as? Bool == false)
        liveReference.supplyFixture(pcm(stereo, frames: 480), at: now + 0.01)
        let active = route.process(input, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: now + 0.01)))
        try check(active?.frameLength == 480 && states.last?["on"] as? Bool == true)
        // A genuine all-zero render callback keeps AEC alive. A stale callback
        // with the same zeros degrades and preserves the microphone verbatim.
        liveReference.ageFixture()
        let degraded = route.process(input, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: now + 0.02)))
        try check(degraded?.frameLength == 480 && degraded!.floatChannelData![0][0] == 0.125 && states.last?["on"] as? Bool == false)

        let heldReference = SystemAudioReference(fixtureFormat: stereo)
        heldReference.supplyFixture(pcm(stereo, frames: 4800), at: now)
        let held = SpeechEchoCancellation(sourceFormat: mono, reference: heldReference, startReference: false, captureHeadroomMs: 40) { _ in }
        let prefix = held.processChunk(pcm(mono, frames: 4800, sample: 0.125), at: firstTime)
        try check(prefix?.buffer.frameLength == 2880 && abs(prefix!.at - now) < 1e-8)
        try check(held.diagnostics()["capturePendingFrames"] as? Int == 1920)
        let tail = try held.flush()
        try check(tail.count == 1 && tail[0].buffer.frameLength == 1920 && abs(tail[0].at - (now + 0.06)) < 1e-8)
        try check(try held.flush().isEmpty)

        let failedReference = SystemAudioReference(fixtureFormat: stereo)
        failedReference.supplyFixture(pcm(stereo, frames: 4800), at: now)
        let fallback = SpeechEchoCancellation(sourceFormat: mono, reference: failedReference, startReference: false, captureHeadroomMs: 40) { _ in }
        _ = fallback.processChunk(pcm(mono, frames: 4800, sample: 0.125), at: firstTime)
        failedReference.ageFixture()
        let released = fallback.processChunk(input, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: now + 0.1)))
        try check(released?.buffer.frameLength == 2400 && abs(released!.at - (now + 0.06)) < 1e-8)
        try check(withExtendedLifetime(released) { released!.buffer.floatChannelData![0][0] == 0.125 && released!.buffer.floatChannelData![0][2399] == 0.125 })
        try check(fallback.diagnostics()["capturePendingFrames"] as? Int == 0)

        // Replay both physical sample clocks through the real adapters. The
        // 60ms capture queue must retain its original timestamps, and its
        // reference lead must be reported as positive buffering delay at either
        // native or converted sample rates. No device or recognizer is opened.
        for rate in [48000.0, 44100.0] {
            let sourceMic = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
            let sourceRender = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
            let clockedReference = SystemAudioReference(fixtureFormat: sourceRender)
            let clocked = SpeechEchoCancellation(sourceFormat: sourceMic, reference: clockedReference,
                startReference: false, captureHeadroomMs: 60) { _ in }
            var nextOutputAt = now, delivered = 0
            for index in 0..<8 {
                let at = now + Double(index) * 0.1
                let count = Int(rate / 10)
                clockedReference.supplyFixture(pcm(sourceRender, frames: count), at: at)
                if let signal = clocked.processChunk(pcm(sourceMic, frames: count, sample: 0.01),
                    at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: at))) {
                    try check(abs(signal.at - nextOutputAt) < 1e-7)
                    nextOutputAt = signal.endAt; delivered += Int(signal.buffer.frameLength)
                    let diagnostics = clocked.diagnostics()
                    let leadMs = -(diagnostics["referenceLagMs"] as! Double)
                    let delayMs = diagnostics["aecBufferingDelayMs"] as! Int
                    try check(leadMs > 0 && Double(delayMs) >= leadMs - 1 && Double(delayMs) < leadMs + 50)
                }
            }
            for signal in try clocked.flush() {
                try check(abs(signal.at - nextOutputAt) < 1e-7)
                nextOutputAt = signal.endAt; delivered += Int(signal.buffer.frameLength)
            }
            try check(abs(delivered - 38400) <= 1)
        }

        let resampled = SpeechEchoCancellation(sourceFormat: AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!,
            reference: SystemAudioReference(), startReference: false) { _ in }
        var delivered = 0
        for index in 0..<10 {
            if let output = resampled.process(pcm(AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!, frames: 441),
                at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: now + Double(index) * 0.01))) {
                try check(output.format == mono && output.frameLength % 480 == 0)
                delivered += Int(output.frameLength)
            }
        }
        try check(delivered >= 4320 && delivered <= 4800)
        return ["echoRouting": true, "timestampOrder": true, "stereoReference": true, "boundedRing": true,
                "silentReferenceIsLive": true, "staleReferenceBypasses": true, "rawInputPreserved": true,
                "conversionFrames": true, "boundedCaptureHeadroom": true, "headroomFlush": true,
                "bufferingDelayClock": true, "bufferingDelayScheduling": true, "firstReferenceDeadline": true,
                "headroomSampleClocks": true,
                "referenceFailureReleasesRaw": true, "recognizerStarted": false, "devicesStarted": false, "checks": checks]
    }
}
