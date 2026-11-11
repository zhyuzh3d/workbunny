// Offline-only SpeechAnalyzer experiment. Never opens AVAudioEngine or a microphone,
// requests authorization, installs assets, or imports WorkBunny business code.
import Foundation
import AVFoundation
import Speech
import Darwin

enum ReplayError: Error { case invalid(String) }
func invalid(_ reason: String) -> ReplayError { .invalid(reason) }
func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }
func normalized(_ text: String) -> [Character] {
    Array(text.lowercased().filter { !$0.isWhitespace && !$0.isPunctuation })
}
func distance(_ a: [Character], _ b: [Character]) -> Int {
    var row = Array(0...b.count)
    for (i, x) in a.enumerated() {
        var next = [i + 1] + Array(repeating: 0, count: b.count)
        for (j, y) in b.enumerated() { next[j + 1] = min(next[j] + 1, row[j + 1] + 1, row[j] + (x == y ? 0 : 1)) }
        row = next
    }
    return row[b.count]
}
func lcs(_ a: [Character], _ b: [Character]) -> Int {
    var row = Array(repeating: 0, count: b.count + 1)
    for x in a {
        var next = row
        for (j, y) in b.enumerated() { next[j + 1] = x == y ? row[j] + 1 : max(row[j + 1], next[j]) }
        row = next
    }
    return row[b.count]
}

struct Options {
    var values: [String: String] = [:]
    init() throws {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count % 2 == 0 else { throw invalid("arguments must be --key value pairs") }
        let known: Set<String> = ["--diagnostic", "--wav", "--output", "--detector", "--reporting", "--speed", "--reference-file", "--timeout", "--lang", "--generation", "--context-file"]
        for i in stride(from: 0, to: args.count, by: 2) {
            guard known.contains(args[i]), values[args[i]] == nil else { throw invalid("unknown or duplicate option") }
            values[args[i]] = args[i + 1]
        }
    }
    subscript(_ key: String) -> String? { values[key] }
}
struct Recording {
    var buffers: [AVAudioPCMBuffer]
    var duration: Double { buffers.reduce(0) { $0 + Double($1.frameLength) / $1.format.sampleRate } }
    var nativeOutputs: [[String: Any]] = []

    static func diagnostic(_ path: String, generation: Int? = nil) throws -> Recording {
        let root = URL(fileURLWithPath: path)
        let pcm = try Data(contentsOf: root.appendingPathComponent("processed-audio.pcm"))
        let lines = try String(contentsOf: root.appendingPathComponent("native-events.ndjson"), encoding: .utf8)
        let records = try lines.split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] ?? [:] }
        var selected: Set<Int> = []
        if let generation {
            for e in records where e["event"] as? String == "audio-offer" && Int(number(e["gen"])) == generation {
                if ["direct", "replay"].contains(e["route"] as? String ?? ""), e["yieldResult"] as? String == "enqueued" { selected.insert(Int(number(e["seq"]))) }
            }
            guard !selected.isEmpty else { throw invalid("generation has no accepted direct/replay audio offers") }
        }
        var buffers: [AVAudioPCMBuffer] = [], outputs: [[String: Any]] = []
        for e in records {
            if let output = e["output"] as? [String: Any], ["partial", "utterance", "final"].contains(output["t"] as? String ?? "") { outputs.append(output) }
            guard e["event"] as? String == "audio-buffer" else { continue }
            if generation != nil && !selected.contains(Int(number(e["seq"]))) { continue }
            guard e["pcmSaved"] as? Bool == true, let planes = e["planes"] as? [[String: Any]] else { throw invalid("audio-buffer has no saved PCM") }
            let channels = UInt32(number(e["channels"])), frames = UInt32(number(e["frames"]))
            var asbd = AudioStreamBasicDescription(mSampleRate: number(e["rate"]), mFormatID: UInt32(number(e["formatID"])), mFormatFlags: UInt32(number(e["formatFlags"])), mBytesPerPacket: UInt32(number(e["bytesPerFrame"])), mFramesPerPacket: 1, mBytesPerFrame: UInt32(number(e["bytesPerFrame"])), mChannelsPerFrame: channels, mBitsPerChannel: UInt32(number(e["bitsPerChannel"])), mReserved: 0)
            guard asbd.mFormatID == kAudioFormatLinearPCM, frames > 0, channels > 0,
                  let format = AVAudioFormat(streamDescription: &asbd),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw invalid("unsupported diagnostic PCM format") }
            buffer.frameLength = frames
            let target = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
            guard target.count == planes.count else { throw invalid("PCM plane count mismatch") }
            for (i, plane) in planes.enumerated() {
                let offset = Int(number(plane["offset"])), count = Int(number(plane["bytes"]))
                guard Int(number(plane["plane"])) == i, offset >= 0, count == Int(target[i].mDataByteSize),
                      offset <= pcm.count, count <= pcm.count - offset, let dest = target[i].mData else { throw invalid("PCM plane range mismatch") }
                _ = pcm.withUnsafeBytes { raw in memcpy(dest, raw.baseAddress!.advanced(by: offset), count) }
            }
            buffers.append(buffer)
        }
        guard !buffers.isEmpty else { throw invalid("no saved audio-buffer records") }
        return Recording(buffers: buffers, nativeOutputs: outputs)
    }

    static func wav(_ path: String) throws -> Recording {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let frames = AVAudioFrameCount(max(1, file.processingFormat.sampleRate * 0.04))
        var buffers: [AVAudioPCMBuffer] = []
        while file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames) else { throw invalid("WAV buffer allocation") }
            try file.read(into: buffer, frameCount: frames)
            if buffer.frameLength > 0 { buffers.append(buffer) }
        }
        guard !buffers.isEmpty else { throw invalid("empty audio file") }
        return Recording(buffers: buffers)
    }

    func converted(to format: AVAudioFormat) throws -> Recording {
        guard let source = buffers.first?.format else { throw invalid("no audio") }
        guard buffers.allSatisfy({ $0.format == source }) else { throw invalid("format changed inside recording") }
        if source == format { return self }
        guard let converter = AVAudioConverter(from: source, to: format) else { throw invalid("audio converter unavailable") }
        var index = 0, result: [AVAudioPCMBuffer] = []
        while true {
            let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, format.sampleRate * 0.04)))!
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, state in
                guard index < self.buffers.count else { state.pointee = .endOfStream; return nil }
                let buffer = self.buffers[index]; index += 1; state.pointee = .haveData; return buffer
            }
            if let error { throw error }
            if out.frameLength > 0 { result.append(out) }
            if status == .endOfStream { break }
            if status == .error { throw invalid("audio conversion failed") }
        }
        return Recording(buffers: result, nativeOutputs: nativeOutputs)
    }
}

actor Results {
    struct Segment { var start: Double; var end: Double; var text: String; var final: Bool }
    var started = ProcessInfo.processInfo.systemUptime
    var submitted = 0.0
    var segments: [Segment] = []
    var events: [[String: Any]] = [], detections: [[String: Any]] = []
    func start() { started = ProcessInfo.processInfo.systemUptime }
    func input(_ seconds: Double) { submitted = seconds }
    func record(_ r: SpeechTranscriber.Result) {
        let start = r.range.start.seconds, end = r.range.end.seconds, text = String(r.text.characters)
        segments.removeAll { $0.start < end - 0.0001 && $0.end > start + 0.0001 || abs($0.start - start) < 0.0001 }
        segments.append(Segment(start: start, end: end, text: text, final: r.isFinal))
        events.append(["arrivalSeconds": ProcessInfo.processInfo.systemUptime - started, "submittedAudioSeconds": submitted,
            "startSeconds": start, "endSeconds": end, "finalizationSeconds": r.resultsFinalizationTime.seconds,
            "isFinal": r.isFinal, "characters": text.count, "text": text])
    }
    func detection(_ r: SpeechDetector.Result) {
        detections.append(["arrivalSeconds": ProcessInfo.processInfo.systemUptime - started, "startSeconds": r.range.start.seconds,
            "endSeconds": r.range.end.seconds, "speechDetected": r.speechDetected])
    }
    func report(reference: String?, speed: Double) -> ([String: Any], [String: Any]) {
        let ordered = segments.sorted { $0.start < $1.start }
        let text = ordered.map(\.text).joined()
        let finalText = ordered.filter(\.final).map(\.text).joined()
        let nonempty = events.filter { number($0["characters"]) > 0 }
        let lags = speed > 0 ? nonempty.map { number($0["arrivalSeconds"]) - number($0["endSeconds"]) / speed }.sorted() : []
        var summary: [String: Any] = ["resultCount": events.count, "nonemptyResultCount": nonempty.count,
            "finalResultCount": events.filter { $0["isFinal"] as? Bool == true }.count, "characters": text.count,
            "finalCharacters": finalText.count, "remainingVolatileCharacters": ordered.filter { !$0.final }.map(\.text).joined().count,
            "detectorResultCount": detections.count,
            "speechDetectedCount": detections.filter { $0["speechDetected"] as? Bool == true }.count,
            "wallSeconds": ProcessInfo.processInfo.systemUptime - started]
        if let first = nonempty.first { summary["firstResultSeconds"] = first["arrivalSeconds"]; summary["firstResultSubmittedAudioSeconds"] = first["submittedAudioSeconds"] }
        if !lags.isEmpty { summary["rangeEndLagP50Seconds"] = lags[lags.count / 2]; summary["rangeEndLagMaxSeconds"] = lags.last! }
        if let reference {
            let expected = normalized(reference), actual = normalized(text)
            summary["referenceCharacters"] = expected.count
            if !expected.isEmpty {
                summary["characterErrorRate"] = Double(distance(expected, actual)) / Double(expected.count)
                summary["orderedCharacterRecall"] = Double(lcs(expected, actual)) / Double(expected.count)
                summary["finalCharacterErrorRate"] = Double(distance(expected, normalized(finalText))) / Double(expected.count)
                summary["finalOrderedCharacterRecall"] = Double(lcs(expected, normalized(finalText))) / Double(expected.count)
            }
        }
        return (summary, ["transcript": text, "finalTranscript": finalText, "results": events, "detections": detections])
    }
}

@main struct Replay {
    static func main() async {
        do { try await run() }
        catch { fputs("speech-replay failed: \(error)\n", stderr); Darwin.exit(1) }
    }
    static func run() async throws {
        let args = try Options()
        guard (args["--diagnostic"] != nil) != (args["--wav"] != nil), let output = args["--output"] else {
            throw invalid("use --diagnostic DIR or --wav FILE, --output NEW_PRIVATE_JSON, [--detector none|low|medium|high] [--reporting volatile|volatile-fast] [--speed 1] [--reference-file FILE] [--timeout 90]")
        }
        let detectorMode = args["--detector"] ?? "none", reporting = args["--reporting"] ?? "volatile-fast"
        guard ["none", "low", "medium", "high"].contains(detectorMode), ["volatile", "volatile-fast"].contains(reporting),
              let speed = Double(args["--speed"] ?? "1"), speed >= 0,
              let timeout = Double(args["--timeout"] ?? "90"), timeout > 0 else { throw invalid("invalid mode, speed, or timeout") }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { fputs("speech-replay timeout\n", stderr); Darwin._exit(124) }
        let locale = Locale(identifier: args["--lang"] ?? "zh-CN")
        guard let installed = await SpeechTranscriber.supportedLocale(equivalentTo: locale),
              await SpeechTranscriber.installedLocales.contains(where: { $0.identifier == installed.identifier }) else { throw invalid("requested locale is not already installed; downloads are disabled") }
        let generation = args["--generation"].flatMap(Int.init)
        guard args["--generation"] == nil || (generation != nil && args["--diagnostic"] != nil) else { throw invalid("generation requires a diagnostic and integer ID") }
        let source = try args["--diagnostic"].map { try Recording.diagnostic($0, generation: generation) } ?? Recording.wav(args["--wav"]!)
        let transcriber = SpeechTranscriber(locale: installed, transcriptionOptions: [], reportingOptions: reporting == "volatile" ? [.volatileResults] : [.volatileResults, .fastResults], attributeOptions: [.audioTimeRange])
        let sensitivity: SpeechDetector.SensitivityLevel = detectorMode == "low" ? .low : detectorMode == "high" ? .high : .medium
        let detector = detectorMode == "none" ? nil : SpeechDetector(detectionOptions: .init(sensitivityLevel: sensitivity), reportResults: true)
        var modules: [any SpeechModule] = [transcriber]
        if let detector { modules.append(detector) }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules, considering: source.buffers[0].format) else { throw invalid("no compatible audio format") }
        let recording = try source.converted(to: format)
        let analyzer = SpeechAnalyzer(modules: modules)
        var contextCount = 0
        if let path = args["--context-file"] {
            let strings = try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
            let context = AnalysisContext(); context.contextualStrings[.general] = strings
            try await analyzer.setContext(context); contextCount = strings.count
        }
        try await analyzer.prepareToAnalyze(in: format)
        let results = Results()
        let transcriptionTask = Task { for try await result in transcriber.results { await results.record(result) } }
        let detectionTask = Task { if let detector { for try await result in detector.results { await results.detection(result) } } }
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        try await analyzer.start(inputSequence: stream)
        await results.start()
        let started = ProcessInfo.processInfo.systemUptime
        var position = 0.0
        for buffer in recording.buffers {
            position += Double(buffer.frameLength) / buffer.format.sampleRate
            // Deliver each recorded callback only once its samples have elapsed.
            if speed > 0 {
                let delay = started + position / speed - ProcessInfo.processInfo.systemUptime
                if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            }
            await results.input(position)
            continuation.yield(AnalyzerInput(buffer: buffer))
        }
        continuation.finish()
        var errors: [String] = []
        var finalizerCompleted = false, transcriptionCompleted = false, detectionCompleted = false
        do { try await analyzer.finalizeAndFinishThroughEndOfInput(); finalizerCompleted = true }
        catch { errors.append("finalizer: \(error)"); await analyzer.cancelAndFinishNow() }
        do { try await transcriptionTask.value; transcriptionCompleted = true }
        catch { errors.append("transcriber results: \(error)") }
        do { try await detectionTask.value; detectionCompleted = true }
        catch { errors.append("detector results: \(error)") }
        let reference = try args["--reference-file"].map { try String(contentsOfFile: $0, encoding: .utf8) }
        let (summary, evidence) = await results.report(reference: reference, speed: speed)
        let completion: [String: Any] = ["finalizerCompleted": finalizerCompleted, "transcriberResultsCompleted": transcriptionCompleted, "detectorResultsCompleted": detectionCompleted, "errorCount": errors.count]
        let result: [String: Any] = ["schema": 1, "detector": detectorMode, "reporting": reporting, "speed": speed,
            "generation": generation as Any? ?? NSNull(), "contextCount": contextCount,
            "audioSeconds": recording.duration, "sourceAudioSeconds": source.duration, "source": args["--diagnostic"] ?? args["--wav"]!,
            "locale": installed.identifier, "sampleRate": format.sampleRate, "channels": format.channelCount,
            "summary": summary, "completion": completion, "errors": errors, "evidence": evidence, "nativeOutputs": source.nativeOutputs,
            "notes": ["Latency is arrival minus result audio-range end, with replay speed applied; includes model buffering and post-input finalization.", "No reference means recall is not scored. Native ASR output is evidence, not human ground truth."]]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
        let fd = Darwin.open(output, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw invalid("output must be a new writable file") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: data); try handle.close()
        let publicResult: [String: Any] = ["detector": detectorMode, "reporting": reporting, "audioSeconds": recording.duration, "summary": summary, "completion": completion, "output": output]
        print(String(data: try JSONSerialization.data(withJSONObject: publicResult, options: [.sortedKeys]), encoding: .utf8)!)
        if !errors.isEmpty { Darwin.exit(1) }
    }
}
