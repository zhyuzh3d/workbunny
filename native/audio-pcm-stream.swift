import Foundation
import AVFoundation

struct AudioPCMChunk {
    let buffer: AVAudioPCMBuffer
    // Time of the first sample, never the callback/delivery time.
    let at: Double
    var endAt: Double { at + Double(buffer.frameLength) / buffer.format.sampleRate }
    var audioTime: AVAudioTime { AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: at)) }
}

// A physical PCM stream owns its converter and clock across hardware callbacks
// and Analyzer sessions. Converter buffering cannot relabel old audio with the
// arrival time of a newer buffer. Only a real discontinuity resets this clock.
final class AudioPCMStreamConverter {
    enum Failure: Error { case invalidInput, unavailable, conversion, bufferLimit }
    let target: AVAudioFormat
    private var source: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var origin: Double?
    private var nextInputAt: Double?
    private var inputFrames: Int64 = 0, outputFrames: Int64 = 0
    private var ended = false
    private(set) var epoch = 0

    init(target: AVAudioFormat) { self.target = target }
    func reset() {
        converter?.reset(); origin = nil; nextInputAt = nil
        inputFrames = 0; outputFrames = 0; ended = false; epoch += 1
    }
    private func packet(_ buffer: AVAudioPCMBuffer) -> AudioPCMChunk {
        let packet = AudioPCMChunk(buffer: buffer, at: origin! + Double(outputFrames) / target.sampleRate)
        outputFrames += Int64(buffer.frameLength); return packet
    }
    func convert(_ input: AVAudioPCMBuffer, at: Double) throws -> [AudioPCMChunk] {
        let format = input.format, count = Int(input.frameLength)
        guard at.isFinite, at >= 0, format.sampleRate > 0, format.channelCount > 0,
              count > 0, Double(count) <= format.sampleRate * 0.5 else { throw Failure.invalidInput }
        if source != format {
            source = format; reset()
            converter = format == target ? nil : AVAudioConverter(from: format, to: target)
            if format != target && converter == nil { throw Failure.unavailable }
            converter?.primeMethod = .none
            if format.channelCount != target.channelCount {
                converter?.channelMap = (0..<Int(target.channelCount)).map { NSNumber(value: min($0, Int(format.channelCount) - 1)) }
            }
        } else if ended || (nextInputAt.map { abs(at - $0) > 0.02 } ?? false) { reset() }
        if origin == nil { origin = at }
        nextInputAt = at + Double(count) / format.sampleRate
        inputFrames += Int64(count)
        guard let converter else { return [packet(input)] }
        if format.sampleRate == target.sampleRate {
            // The non-SRC API does not introduce the block converter's hidden
            // 4096-frame batching during channel/type/layout conversion.
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: input.frameLength) else { throw Failure.bufferLimit }
            try converter.convert(to: output, from: input)
            guard output.frameLength == input.frameLength else { throw Failure.conversion }
            return [packet(output)]
        }
        var supplied = false
        let packets = try drain(inputFrames: count) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return input
        }
        let pending = Double(inputFrames) / format.sampleRate - Double(outputFrames) / target.sampleRate
        guard pending <= 0.5 else { throw Failure.bufferLimit }
        return packets
    }
    private func drain(inputFrames count: Int, provider: @escaping AVAudioConverterInputBlock) throws -> [AudioPCMChunk] {
        guard let converter, let source, origin != nil else { return [] }
        let pending = max(Double(count), Double(inputFrames) - Double(outputFrames) * source.sampleRate / target.sampleRate)
        let capacity = AVAudioFrameCount(max(pending, ceil(pending * target.sampleRate / source.sampleRate)) + 1024)
        var chunks: [AudioPCMChunk] = []
        for _ in 0..<16 {
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { throw Failure.bufferLimit }
            var error: NSError?
            let status = converter.convert(to: output, error: &error, withInputFrom: provider)
            guard error == nil, status != .error else { throw Failure.conversion }
            if output.frameLength > 0 { chunks.append(packet(output)) }
            if status == .inputRanDry || status == .endOfStream || output.frameLength == 0 { return chunks }
        }
        throw Failure.bufferLimit
    }
    func flush() throws -> [AudioPCMChunk] {
        guard !ended else { return [] }; ended = true
        guard source?.sampleRate != target.sampleRate else { return [] }
        guard let source else { return [] }
        let before = outputFrames
        let finalFrames = Int64((Double(inputFrames) * target.sampleRate / source.sampleRate).rounded())
        var remaining = max(0, finalFrames - before), result: [AudioPCMChunk] = []
        // SRC's synthesized filter tail is not additional captured time.
        // Drain it to finish the converter, but keep the physical duration.
        for chunk in try drain(inputFrames: 0, provider: { _, state in state.pointee = .endOfStream; return nil }) {
            let count = min(remaining, Int64(chunk.buffer.frameLength))
            if count > 0 {
                chunk.buffer.frameLength = AVAudioFrameCount(count)
                result.append(chunk); remaining -= count
            }
        }
        outputFrames = finalFrames - remaining
        return result
    }

    static func selfTest() throws -> [String: Any] {
        var checks = 0
        func check(_ condition: Bool) throws {
            checks += 1
            if !condition { throw NSError(domain: "bunny.pcm-stream.self-test", code: checks) }
        }
        func buffer(rate: Double, frames: Int, channels: AVAudioChannelCount = 2) -> AVAudioPCMBuffer {
            let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels)!
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
            pcm.frameLength = AVAudioFrameCount(frames)
            for channel in 0..<Int(channels) { pcm.floatChannelData![channel].update(repeating: channel == 0 ? 0.125 : -0.25, count: frames) }
            return pcm
        }
        let same = AudioPCMStreamConverter(target: AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!)
        for index in 0..<40 {
            let chunks = try same.convert(buffer(rate: 48000, frames: 4800), at: 10 + Double(index) * 0.1)
            try check(chunks.count == 1 && chunks[0].buffer.frameLength == 4800)
            try check(withExtendedLifetime(chunks) { abs(chunks[0].at - (10 + Double(index) * 0.1)) < 1e-8 && chunks[0].buffer.floatChannelData![0][4799] == 0.125 })
        }
        try check(try same.flush().isEmpty)
        for interleaved in [false, true] {
            let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 2, interleaved: interleaved)!
            let converter = AudioPCMStreamConverter(target: target)
            let chunks = try converter.convert(buffer(rate: 48000, frames: 4800), at: 1)
            let output = chunks[0].buffer
            try check(output.frameLength == 4800 && output.int16ChannelData![0][0] == 4096)
            try check((interleaved ? output.int16ChannelData![0][1] : output.int16ChannelData![1][0]) == -8192)
        }
        for (rate, targetRate) in [(44100.0,16000.0),(48000.0,16000.0),(96000.0,48000.0),(192000.0,48000.0)] {
            let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: targetRate, channels: 1, interleaved: true)!
            let converter = AudioPCMStreamConverter(target: target)
            var inputFrames = 0, outputFrames = 0
            func observe(_ chunks: [AudioPCMChunk]) throws {
                for chunk in chunks {
                    try check(abs(chunk.at - (20 + Double(outputFrames) / targetRate)) < 1e-8)
                    try check(chunk.buffer.format == target && chunk.buffer.frameLength > 0)
                    outputFrames += Int(chunk.buffer.frameLength)
                }
            }
            for count in [512,4800,441,8192,1024,4800,257,9600] {
                try observe(converter.convert(buffer(rate: rate, frames: count), at: 20 + Double(inputFrames) / rate))
                inputFrames += count
            }
            try observe(converter.flush())
            try check(abs(Double(outputFrames) - Double(inputFrames) * targetRate / rate) <= 1.1)
            try check(try converter.flush().isEmpty)
            let epoch = converter.epoch
            let restarted = try converter.convert(buffer(rate: rate, frames: 4800), at: 30)
            try check(converter.epoch > epoch && restarted.first.map { abs($0.at - 30) < 1e-8 } == true)
            let beforeGap = converter.epoch
            let afterGap = try converter.convert(buffer(rate: rate, frames: 4800), at: 40)
            try check(converter.epoch > beforeGap && afterGap.first.map { abs($0.at - 40) < 1e-8 } == true)
        }
        return ["pcmStream": true, "sampleClock": true, "sameRateNoBuffering": true, "integerLayouts": true,
                "resampleContinuity": true, "flushOnce": true, "gapReset": true, "highRates": true,
                "devicesStarted": false, "recognizerStarted": false, "checks": checks]
    }
}
