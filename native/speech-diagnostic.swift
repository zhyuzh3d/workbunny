import Foundation
import AVFoundation
import Darwin

// Explicit, short-lived private evidence. Nothing in this writer is sent to
// stdout. Audio offers describe producer-side queue admission, not consumption.
final class SpeechDiagnostic {
    struct Limits {
        var events = 2 * 1024 * 1024
        var pcm = 32 * 1024 * 1024
        var pending = 1024 * 1024
    }
    enum Failure: Error { case invalidDirectory, directoryRoot, directoryComponent, directoryPermissions, fileExists, invalidDuration }
    private let lock = NSLock()
    private let writer = DispatchQueue(label: "bunny.speech-diagnostic.writer")
    private let control = DispatchQueue(label: "bunny.speech-diagnostic.control")
    private var eventFD: Int32 = -1, pcmFD: Int32 = -1
    private var timer: DispatchSourceTimer?
    private var accepting = true, finishing = false
    private var stopCode: Int?
    private var pendingBytes = 0, eventBytes = 0, pcmBytes = 0, sequence = 0, frameOffset: Int64 = 0
    private var overflows = 0
    private let limits: Limits
    private let tailReserve: Int
    private let onStop: (Int) -> Void
    let startedUptime = ProcessInfo.processInfo.systemUptime
    let startedWallTime = Date().timeIntervalSince1970
    let durationMs: Int

    init(directory: String, durationMs: Int, pcm: Bool, limits: Limits = Limits(), onStop: @escaping (Int) -> Void = { _ in }) throws {
        guard (1...20000).contains(durationMs) else { throw Failure.invalidDuration }
        self.durationMs = durationMs; self.limits = limits; self.onStop = onStop
        tailReserve = min(4096, max(256, limits.events / 4))
        // Walk every component with openat/no-follow; the host must pass the
        // canonical path (including /private/tmp rather than its /tmp alias).
        let components = directory.split(separator: "/", omittingEmptySubsequences: false)
        guard directory.hasPrefix("/"), directory != "/", !directory.utf8.contains(0),
              components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw Failure.invalidDirectory }
        var directoryFD = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryFD >= 0 else { throw Failure.directoryRoot }
        for part in directory.split(separator: "/") {
            let next = part.withCString { openat(directoryFD, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            Darwin.close(directoryFD); directoryFD = next
            guard directoryFD >= 0 else { throw Failure.directoryComponent }
        }
        defer { Darwin.close(directoryFD) }
        var info = stat()
        guard fstat(directoryFD, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o777) == 0o700 else { throw Failure.directoryPermissions }
        let flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK
        eventFD = openat(directoryFD, "native-events.ndjson", flags, 0o600)
        guard eventFD >= 0 else { throw Failure.fileExists }
        if pcm {
            pcmFD = openat(directoryFD, "processed-audio.pcm", flags, 0o600)
            if pcmFD < 0 { Darwin.close(eventFD); eventFD = -1; throw Failure.fileExists }
        }
        record("clock", ["uptime": startedUptime, "wallTime": startedWallTime, "durationMs": durationMs, "pcmEnabled": pcm])
        // Reserve bounded drain time inside the requested total lifetime.
        let drainMs = min(250, max(1, durationMs / 4))
        let timer = DispatchSource.makeTimerSource(queue: control)
        let remaining = startedUptime + Double(durationMs - drainMs) / 1000 - ProcessInfo.processInfo.systemUptime
        timer.schedule(deadline: .now() + max(0, remaining))
        timer.setEventHandler { [weak self] in self?.requestStop(0) }
        self.timer = timer; timer.resume()
    }

    var reasonCode: Int { lock.lock(); defer { lock.unlock() }; return stopCode ?? 0 }
    private func requestStop(_ code: Int) {
        lock.lock()
        if stopCode != nil { lock.unlock(); return }
        stopCode = code; accepting = false; if [42, 43, 44].contains(code) { overflows += 1 }
        lock.unlock()
        control.async { [self] in onStop(code) }
    }
    private static func line(_ value: [String: Any]) -> Data? {
        guard JSONSerialization.isValidJSONObject(value), var data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        data.append(0x0a); return data
    }
    private func write(_ data: Data, to fd: Int32) -> Bool {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return true }
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { return false }; offset += count
            }
            return true
        }
    }
    // Own lock is held. Budgets are reserved before any queued PCM copies.
    private func reserve(_ events: Int, _ pcm: Int) -> Int? {
        if !accepting { return -1 }
        if eventBytes + events > limits.events - tailReserve { return 42 }
        if pcmBytes + pcm > limits.pcm { return 43 }
        if pendingBytes + events + pcm > limits.pending { return 44 }
        eventBytes += events; pcmBytes += pcm; pendingBytes += events + pcm; return nil
    }
    private func submit(_ event: Data, planes: [Data] = []) {
        let bytes = event.count + planes.reduce(0) { $0 + $1.count }
        writer.async { [self] in
            var ok = write(event, to: eventFD)
            for plane in planes where ok { ok = write(plane, to: pcmFD) }
            lock.lock(); pendingBytes -= bytes; lock.unlock()
            if !ok { requestStop(45) }
        }
    }
    func record(_ event: String, _ fields: [String: Any] = [:]) {
        var value = fields; value["event"] = event; value["uptime"] = ProcessInfo.processInfo.systemUptime
        guard let data = Self.line(value) else { requestStop(46); return }
        lock.lock(); let refusal = reserve(data.count, 0)
        if refusal == nil { submit(data) }; lock.unlock()
        if let refusal, refusal >= 0 { requestStop(refusal) }
    }
    func capture(_ buffer: AVAudioPCMBuffer, gen: Int, audioTime: AVAudioTime?) -> Int? {
        lock.lock()
        guard accepting else { lock.unlock(); return nil }
        sequence += 1; let seq = sequence, offset = frameOffset; frameOffset += Int64(buffer.frameLength)
        let list = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let description = buffer.format.streamDescription.pointee
        let frameBytes = Int(buffer.frameLength) * Int(description.mBytesPerFrame)
        guard list.count <= 64, description.mBytesPerFrame > 0,
              list.allSatisfy({ Int($0.mDataByteSize) == frameBytes && ($0.mData != nil || frameBytes == 0) }) else {
            lock.unlock(); requestStop(46); return nil
        }
        let total = list.reduce(0) { $0 + Int($1.mDataByteSize) }, savedBytes = pcmFD >= 0 ? total : 0
        var position = pcmBytes
        let planes: [[String: Any]] = list.enumerated().map { index, plane in
            defer { if pcmFD >= 0 { position += Int(plane.mDataByteSize) } }
            return ["plane": index, "channels": Int(plane.mNumberChannels), "bytes": Int(plane.mDataByteSize), "offset": pcmFD >= 0 ? position : -1]
        }
        let f = buffer.format.streamDescription.pointee
        var value: [String: Any] = ["event": "audio-buffer", "uptime": ProcessInfo.processInfo.systemUptime, "seq": seq, "gen": gen,
            "frameOffset": offset, "frames": Int(buffer.frameLength), "rate": buffer.format.sampleRate, "channels": Int(buffer.format.channelCount),
            "interleaved": buffer.format.isInterleaved, "formatID": f.mFormatID, "formatFlags": f.mFormatFlags, "bitsPerChannel": f.mBitsPerChannel,
            "bytesPerFrame": f.mBytesPerFrame, "planes": planes, "pcmSaved": pcmFD >= 0]
        if let time = audioTime {
            value["hostTimeValid"] = time.isHostTimeValid; value["sampleTimeValid"] = time.isSampleTimeValid
            if time.isHostTimeValid { value["captureHostSeconds"] = AVAudioTime.seconds(forHostTime: time.hostTime) }
            if time.isSampleTimeValid { value["captureSampleTime"] = time.sampleTime; value["captureRate"] = time.sampleRate }
        }
        guard let event = Self.line(value) else { lock.unlock(); requestStop(46); return nil }
        if let refusal = reserve(event.count, savedBytes) { lock.unlock(); if refusal >= 0 { requestStop(refusal) }; return nil }
        var copies: [Data] = []
        if pcmFD >= 0 {
            for plane in list {
                guard let source = plane.mData else { lock.unlock(); requestStop(46); return nil }
                copies.append(Data(bytes: source, count: Int(plane.mDataByteSize)))
            }
        }
        submit(event, planes: copies); lock.unlock(); return seq
    }
    static func yieldCategory<T>(_ result: AsyncStream<T>.Continuation.YieldResult) -> String {
        switch result { case .enqueued: return "enqueued"; case .dropped: return "dropped"; case .terminated: return "terminated"; @unknown default: return "unknown" }
    }
    func offer(seq: Int?, gen: Int, route: String, outcome: String) {
        guard let seq else { return }; record("audio-offer", ["seq": seq, "gen": gen, "route": route, "yieldResult": outcome, "consumerObserved": false])
    }
    func finish(code: Int = 0, completion: @escaping () -> Void) {
        lock.lock()
        if finishing { lock.unlock(); return }
        finishing = true; accepting = false; if stopCode == nil { stopCode = code }
        timer?.cancel(); timer = nil
        let result: [String: Any] = ["event": "diagnostic-end", "uptime": ProcessInfo.processInfo.systemUptime, "wallTime": Date().timeIntervalSince1970,
            "reasonCode": stopCode ?? code, "eventBytesReserved": eventBytes, "pcmBytesReserved": pcmBytes, "overflows": overflows, "buffers": sequence]
        let tail = Self.line(result)!; lock.unlock()
        writer.async { [self] in
            // Reserved tail remains writable after a cap is reached.
            let written = write(tail, to: eventFD)
            if !written { lock.lock(); stopCode = 45; lock.unlock() }
            Darwin.close(eventFD); eventFD = -1; if pcmFD >= 0 { Darwin.close(pcmFD); pcmFD = -1 }
            completion()
        }
    }

    // Pure fixtures: no engine, permissions, SpeechAnalyzer, locale or assets.
    static func selfTest() throws -> [String: Any] {
        enum TestFailure: Error { case assertion }
        var checkNumber = 0
        func check(_ value: Bool) throws { checkNumber += 1; if !value { throw NSError(domain: "bunny.speech-diagnostic-selftest", code: checkNumber) } }
        let files = FileManager.default
        // NSURL deliberately shortens /private/var to the /var alias on macOS;
        // POSIX realpath supplies the no-symlink spelling required by openat.
        guard let canonical = realpath(NSTemporaryDirectory(), nil) else { throw Failure.invalidDirectory }
        let temporary = String(cString: canonical); free(canonical)
        let base = URL(fileURLWithPath: temporary).appendingPathComponent("bunny-speech-diagnostic-" + UUID().uuidString)
        try files.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? files.removeItem(at: base) }
        let disabled: SpeechDiagnostic? = nil
        disabled?.record("disabled-canary")
        try check(try files.contentsOfDirectory(atPath: base.path).isEmpty)
        func directory(_ name: String, mode: Int = 0o700) throws -> String {
            let path = base.appendingPathComponent(name).path
            try files.createDirectory(atPath: path, withIntermediateDirectories: false, attributes: [.posixPermissions: mode]); return path
        }
        func finish(_ value: SpeechDiagnostic) throws {
            let done = DispatchSemaphore(value: 0); value.finish { done.signal() }
            try check(done.wait(timeout: .now() + 1) == .success)
        }
        func denied(_ path: String) throws {
            do { let value = try SpeechDiagnostic(directory: path, durationMs: 20000, pcm: false); try finish(value); throw TestFailure.assertion }
            catch is Failure { }
        }
        let good = try directory("good")
        let value = try SpeechDiagnostic(directory: good, durationMs: 20000, pcm: true)
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 2, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4)!
        buffer.frameLength = 4
        for c in 0..<2 { for f in 0..<4 { buffer.floatChannelData![c][f] = Float(c + 1) } }
        let first = value.capture(buffer, gen: 3, audioTime: nil)
        for c in 0..<2 { for f in 0..<4 { buffer.floatChannelData![c][f] = Float(c + 3) } }
        let second = value.capture(buffer, gen: 4, audioTime: nil)
        let (stream, continuation) = AsyncStream<Int>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (enqueued, dropped, terminated) = withExtendedLifetime(stream) {
            let first = yieldCategory(continuation.yield(1)), second = yieldCategory(continuation.yield(2))
            continuation.finish(); return (first, second, yieldCategory(continuation.yield(3)))
        }
        value.offer(seq: first, gen: 3, route: "direct", outcome: enqueued)
        value.offer(seq: second, gen: 4, route: "replay", outcome: dropped)
        value.offer(seq: second, gen: 4, route: "replay", outcome: terminated)
        value.record("raw-result", ["text": "private-diagnostic-canary", "start": 0, "end": 1])
        try finish(value)
        let eventURL = URL(fileURLWithPath: good).appendingPathComponent("native-events.ndjson")
        let pcmURL = URL(fileURLWithPath: good).appendingPathComponent("processed-audio.pcm")
        let bytes = try Data(contentsOf: pcmURL), eventData = try Data(contentsOf: eventURL)
        let events = try String(decoding: eventData, as: UTF8.self).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
        let buffers = events.filter { $0["event"] as? String == "audio-buffer" }
        try check(first == 1 && second == 2 && bytes.count == 64 && buffers.count == 2)
        let samples = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        try check(samples == [1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4])
        try check((buffers[0]["frameOffset"] as? Int) == 0 && (buffers[1]["frameOffset"] as? Int) == 4)
        let planes = buffers[1]["planes"] as! [[String: Any]]
        try check(planes.count == 2 && planes[0]["offset"] as? Int == 32 && planes[1]["offset"] as? Int == 48)
        try check(enqueued == "enqueued" && dropped == "dropped" && terminated == "terminated")
        for path in [eventURL.path, pcmURL.path] {
            let attributes = try files.attributesOfItem(atPath: path)
            try check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        }
        try denied(good); try check(try Data(contentsOf: eventURL) == eventData)
        let unsafe = try directory("unsafe", mode: 0o755); try denied(unsafe)
        let link = base.appendingPathComponent("directory-link").path
        try files.createSymbolicLink(atPath: link, withDestinationPath: good); try denied(link)
        let symlinkFile = try directory("file-link")
        try files.createSymbolicLink(atPath: symlinkFile + "/native-events.ndjson", withDestinationPath: eventURL.path); try denied(symlinkFile)
        try check(try Data(contentsOf: eventURL) == eventData)
        let noPCM = try directory("no-pcm"), metadataOnly = try SpeechDiagnostic(directory: noPCM, durationMs: 20000, pcm: false)
        _ = metadataOnly.capture(buffer, gen: 1, audioTime: nil); try finish(metadataOnly)
        try check(!files.fileExists(atPath: noPCM + "/processed-audio.pcm"))
        for duration in [0, 20001] {
            do { _ = try SpeechDiagnostic(directory: noPCM, durationMs: duration, pcm: false); throw TestFailure.assertion }
            catch Failure.invalidDuration { }
        }
        for (name, limits, expected) in [
            ("event-cap", Limits(events: 1024, pcm: 32768, pending: 8192), 42),
            ("pcm-cap", Limits(events: 8192, pcm: 8, pending: 8192), 43),
            ("pending-cap", Limits(events: 8192, pcm: 32768, pending: 16), 44)
        ] {
            let capped = try SpeechDiagnostic(directory: directory(name), durationMs: 20000, pcm: true, limits: limits)
            if expected == 42 { capped.record("large", ["text": String(repeating: "x", count: 2000)]) }
            else { _ = capped.capture(buffer, gen: 1, audioTime: nil) }
            try check(capped.reasonCode == expected); try finish(capped)
        }
        let timed = DispatchSemaphore(value: 0), timerStart = ProcessInfo.processInfo.systemUptime
        let short = try SpeechDiagnostic(directory: directory("deadline"), durationMs: 20, pcm: false, onStop: { _ in timed.signal() })
        try check(timed.wait(timeout: .now() + 1) == .success && ProcessInfo.processInfo.systemUptime - timerStart < 0.5)
        try finish(short)
        let failed = DispatchSemaphore(value: 0)
        let broken = try SpeechDiagnostic(directory: directory("write-failure"), durationMs: 20000, pcm: false, onStop: { _ in failed.signal() })
        // Drain the initial clock before deliberately breaking this fixture fd.
        broken.writer.sync { Darwin.close(broken.eventFD); broken.eventFD = -1 }
        broken.record("synthetic-write-failure")
        try check(failed.wait(timeout: .now() + 1) == .success && broken.reasonCode == 45)
        try finish(broken)
        return ["t": "selfTest", "speechDiagnostic": true, "privatePermissions": true, "noOverwrite": true, "symlinkRejected": true,
                "bufferOrder": true, "planeOffsets": true, "yieldClassification": true, "caps": true, "deadline": true, "writeFailure": true,
                "disabledNoFiles": true, "recognizerStarted": false]
    }
}
