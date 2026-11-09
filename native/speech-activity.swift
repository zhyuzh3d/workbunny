import Foundation
import AVFoundation

// Independent acoustic evidence only. Reads the exact ASR input without
// conversion, channel selection, gain changes or edits to that input.
final class SpeechActivity {
    enum State: String { case unknown, active, quiet }
    struct Observation {
        let generation: Int
        let state: State
        let quietSeconds: Double
        let at: TimeInterval
        let frames: [SpeechAcousticFrame]
    }
    private let lock = NSLock()
    private var generation: Int?
    private var lastAt: TimeInterval?
    private var rate = 0, channels = 0
    private var interleaved = false
    private var models: [OpaquePointer] = []
    private var partial: [[Int16]] = []
    private var quietFrames = 0
    private var directFrames = 0
    private var confirmedSpeech = false
    private func clear() {
        for model in models { wb_speech_vad_free(model) }
        models.removeAll(); partial.removeAll(); rate = 0; channels = 0; quietFrames = 0
        directFrames = 0; confirmedSpeech = false
    }
    deinit { clear() }
    func observe(_ buffer: AVAudioPCMBuffer, generation requested: Int,
                 at: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Observation {
        lock.lock(); defer { lock.unlock() }
        func unknown() -> Observation { Observation(generation: requested, state: .unknown, quietSeconds: 0, at: at.isFinite ? at : 0, frames: []) }
        guard requested >= 0 else { return unknown() }
        // A delayed old callback cannot reset a newer acoustic generation.
        if let generation, requested < generation { return unknown() }
        // Analyzer ownership changes without restarting the physical stream.
        // Preserve adaptive VAD state, unfinished 10ms frames and the transport
        // clock. Only actual discontinuities/invalid formats clear this DSP.
        if generation != requested { generation = requested }
        guard at.isFinite, at >= 0 else { clear(); lastAt = nil; return unknown() }
        if let previous = lastAt, at < previous || at - previous > 0.5 {
            clear(); lastAt = at; return unknown()
        }
        lastAt = at
        let format = buffer.format, sampleRate = format.sampleRate, count = Int(buffer.frameLength), channelCount = Int(format.channelCount)
        let description = format.streamDescription.pointee
        guard [8000.0,16000.0,32000.0,48000.0].contains(sampleRate), format.commonFormat == .pcmFormatInt16,
              channelCount > 0, channelCount <= 8, count > 0, Double(count) <= sampleRate * 0.5,
              description.mFormatID == kAudioFormatLinearPCM, description.mBitsPerChannel == 16,
              description.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else { clear(); return unknown() }
        let planeCount = format.isInterleaved ? 1 : channelCount
        let bytesPerFrame = format.isInterleaved ? channelCount * 2 : 2
        let planes = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard Int(description.mBytesPerFrame) == bytesPerFrame, planes.count == planeCount,
              planes.allSatisfy({ $0.mData != nil && Int($0.mDataByteSize) >= count * bytesPerFrame && Int($0.mNumberChannels) == (format.isInterleaved ? channelCount : 1) }) else { clear(); return unknown() }
        let wantedRate = Int(sampleRate)
        if !models.isEmpty && (rate != wantedRate || channels != channelCount || interleaved != format.isInterleaved) {
            clear(); return unknown()
        }
        if models.isEmpty {
            rate = wantedRate; channels = channelCount; interleaved = format.isInterleaved
            for _ in 0..<channels {
                guard let model = wb_speech_vad_new(Int32(rate)) else { clear(); return unknown() }
                models.append(model)
            }
            partial = (0..<channels).map { _ in var samples: [Int16] = []; samples.reserveCapacity(rate / 100); return samples }
        }
        let frameLength = rate / 100
        var last: State = .unknown, completeFrames = 0, anyActive = false, anyPending = false
        var classified: [SpeechAcousticFrame] = []
        for index in 0..<count {
            for channel in 0..<channels {
                let plane = interleaved ? 0 : channel, position = interleaved ? index * channels + channel : index
                let source = planes[plane].mData!.assumingMemoryBound(to: Int16.self)
                partial[channel].append(source[position])
            }
            if partial[0].count == frameLength {
                var active = false, directSpeech = false
                for channel in 0..<channels {
                    let result = partial[channel].withUnsafeBufferPointer { wb_speech_vad_process(models[channel], $0.baseAddress!, $0.count) }
                    guard result >= 0 else { clear(); return unknown() }
                    active = active || result > 0
                    directSpeech = directSpeech || result == 1
                    partial[channel].removeAll(keepingCapacity: true)
                }
                completeFrames += 1
                classified.append(SpeechAcousticFrame(start: Double(index + 1 - frameLength) / Double(rate),
                    end: Double(index + 1) / Double(rate), active: directSpeech))
                if directSpeech {
                    directFrames += 1
                    if directFrames >= 6 { confirmedSpeech = true }
                } else { directFrames = 0 }
                if confirmedSpeech && active { quietFrames = 0; last = .active; anyActive = true }
                else if directSpeech { quietFrames = 0; last = .unknown; anyPending = true }
                else { if !active { confirmedSpeech = false }; quietFrames += 1; last = .quiet }
            }
        }
        guard completeFrames > 0 else { return unknown() }
        // Only complete, jointly classified channel frames contribute. Keep
        // the <10ms remainder for the next call, never zero-pad it as silence.
        let remainderSeconds = Double(partial[0].count) / Double(rate)
        let state: State = anyActive ? .active : (anyPending ? .unknown : last)
        return Observation(generation: requested, state: state,
                           quietSeconds: state == .quiet ? Double(quietFrames) / 100 : 0,
                           at: max(0, at - remainderSeconds), frames: classified)
    }
}

// Runs before any permission, capture, locale or SpeechAnalyzer initialization.
func selftestSpeechActivity() -> [String: Any] {
    var passed = true
    func check(_ value: Bool) { passed = passed && value }
    func buffer(rate: Double = 16000, channels: AVAudioChannelCount = 1, frames: Int = 160,
                interleaved: Bool = true, voiceChannel: Int? = nil) -> AVAudioPCMBuffer {
        let format: AVAudioFormat
        if channels > 2 {
            // The channel-count convenience initializer rejects nine channels
            // without a layout. Build a valid discrete fixture, then verify
            // that the observer refuses it at its own eight-channel bound.
            let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | channels)!
            format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, interleaved: interleaved, channelLayout: layout)
        } else {
            format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: channels, interleaved: interleaved)!
        }
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!; buffer.frameLength = AVAudioFrameCount(frames)
        let planes = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        for channel in 0..<Int(channels) { for index in 0..<frames {
            let plane = interleaved ? 0 : channel, position = interleaved ? index * Int(channels) + channel : index
            // The upstream API fixture uses i*i to reliably activate all modes.
            planes[plane].mData!.assumingMemoryBound(to: Int16.self)[position] = channel == voiceChannel ? Int16(truncatingIfNeeded: index * index) : 0
        } }
        return buffer
    }
    for rate in [8000.0,16000.0,32000.0,48000.0] {
        let observer = SpeechActivity(), result = observer.observe(buffer(rate: rate, frames: Int(rate / 100)), generation: 1, at: 1)
        check(result.state == .quiet && abs(result.quietSeconds - 0.01) < 0.000001)
    }
    let burst = buffer(frames: 4800, voiceChannel: 0)
    for index in 160..<4800 { burst.int16ChannelData![0][index] = 0 }
    let burstResult = SpeechActivity().observe(burst, generation: 1, at: 1)
    check(burstResult.frames.contains { $0.active } && burstResult.frames.last?.active == false)
    check(burstResult.state == .unknown && burstResult.quietSeconds == 0)
    // A real sustained run followed by quiet inside one hardware buffer must
    // still report active; a detector-generated tail cannot create that run.
    let sustained = buffer(frames: 4800, voiceChannel: 0)
    for index in 1600..<4800 { sustained.int16ChannelData![0][index] = 0 }
    let sustainedResult = SpeechActivity().observe(sustained, generation: 1, at: 1)
    check(sustainedResult.frames.last?.active == false && sustainedResult.state == .active)
    let impulse = SpeechActivity()
    check(impulse.observe(burst, generation: 1, at: 1).state == .unknown)
    check(impulse.observe(buffer(frames: 1600), generation: 1, at: 1.1).state == .quiet)
    let fragmented = SpeechActivity()
    check(fragmented.observe(buffer(frames: 80), generation: 1, at: 1).state == .unknown)
    check(fragmented.observe(buffer(frames: 80), generation: 2, at: 1.005).quietSeconds == 0.01)
    for size in [1365,1707] {
        let observer = SpeechActivity(); var now = 1.0, total = 0
        var last = observer.observe(buffer(frames: 1), generation: 2, at: now); total += 1
        for index in 0..<12 { now += Double(size) / 16000; total += size; last = observer.observe(buffer(frames: size), generation: index < 6 ? 2 : 3, at: now) }
        check(last.state == .quiet && last.quietSeconds >= 0.9)
        check(abs(last.quietSeconds - Double(total / 160) / 100) < 0.000001)
        check(abs(last.at - (now - Double(total % 160) / 16000)) < 0.000001)
    }
    for interleaved in [true,false] {
        let observer = SpeechActivity(), continuous = SpeechActivity(), input = buffer(channels: 2, frames: 1600, interleaved: interleaved, voiceChannel: 1)
        let planes = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList), before = planes.map { Data(bytes: $0.mData!, count: Int($0.mDataByteSize)) }
        check(observer.observe(input, generation: 3, at: 2).state == .active)
        _ = continuous.observe(input, generation: 3, at: 2)
        check(observer.observe(buffer(channels: 2, interleaved: interleaved), generation: 2, at: 2.001).state == .unknown)
        let next = observer.observe(buffer(channels: 2, interleaved: interleaved), generation: 3, at: 2.01)
        _ = continuous.observe(buffer(channels: 2, interleaved: interleaved), generation: 3, at: 2.01)
        check(next.quietSeconds < 0.1)
        let acrossGeneration = observer.observe(buffer(channels: 2, interleaved: interleaved), generation: 4, at: 2.02)
        let sameGeneration = continuous.observe(buffer(channels: 2, interleaved: interleaved), generation: 3, at: 2.02)
        check(acrossGeneration.state == sameGeneration.state && acrossGeneration.quietSeconds == sameGeneration.quietSeconds)
        check(planes.enumerated().allSatisfy { before[$0.offset] == Data(bytes: $0.element.mData!, count: Int($0.element.mDataByteSize)) })
    }
    let observer = SpeechActivity()
    check(observer.observe(buffer(), generation: 1, at: 1).state == .quiet)
    check(observer.observe(buffer(), generation: 0, at: 1.001).state == .unknown)
    check(observer.observe(buffer(), generation: 1, at: 1.01).quietSeconds == 0.02)
    check(observer.observe(buffer(), generation: 1, at: 2).state == .unknown)
    // Changing the Analyzer cannot hide a physical transport gap.
    check(observer.observe(buffer(), generation: 2, at: 3).state == .unknown)
    check(observer.observe(buffer(), generation: 2, at: 3.01).quietSeconds == 0.01)
    check(observer.observe(buffer(), generation: 1, at: 3.015).state == .unknown)
    check(observer.observe(buffer(), generation: 2, at: 3.02).quietSeconds == 0.02)
    check(observer.observe(buffer(), generation: 2, at: .nan).state == .unknown)
    check(observer.observe(buffer(rate: 44100), generation: 2, at: 3.1).state == .unknown)
    check(observer.observe(buffer(channels: 9), generation: 2, at: 3.2).state == .unknown)
    check(observer.observe(buffer(frames: 8001), generation: 2, at: 3.3).state == .unknown)
    let floatBuffer = AVAudioPCMBuffer(pcmFormat: AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!, frameCapacity: 160)!; floatBuffer.frameLength = 160
    check(observer.observe(floatBuffer, generation: 2, at: 3.4).state == .unknown)
    return ["t":"selfTest", "speechActivity":passed, "mode":0, "frameMs":10, "partialFrames":true, "allChannels":true,
            "generationIsolation":true, "physicalStreamContinuity":true, "gapReset":true,
            "inputUnchanged":true, "resourceBounds":true, "withinBufferActivity":true,
            "directSpeechConfirmation":true, "hangoverIsNotSpeech":true, "transientRejected":true, "recognizerStarted":false]
}
