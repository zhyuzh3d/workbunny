import Foundation
import AVFoundation
import Accelerate
import CoreAudio
import AudioToolbox

// Small local acoustic descriptor, not a learned speaker identity model.
// 16kHz / 512 FFT / 26 mel filters / 13 MFCCs; raw audio never leaves this process.
final class SpeakerFeatures {
    static func inputIdentity(_ node: AVAudioInputNode) -> String {
        guard let unit = node.audioUnit else { return "" }
        var device = AudioDeviceID(0), bytes = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &bytes) == noErr else { return "" }
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var uid: Unmanaged<CFString>?; bytes = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &uid) { AudioObjectGetPropertyData(device, &address, 0, nil, &bytes, $0) }
        guard status == noErr, let uid else { return "" }
        return uid.takeRetainedValue() as String
    }
    let output: ([String: Any]) -> Void
    private let fft: vDSP_DFT_Setup?
    private var window = [Float](repeating: 0, count: 512)
    private var filters = [[Float]]()
    private var dct = [[Float]]()
    private var samples = [Float]()
    private var coefficients = [[Double]]()
    private var pitches = [Double]()
    private var frames = 0, voiceFrames = 0
    private var noise: Float = 0.001
    private let lock = NSLock()
    private var confirmedAt: Double = 0
    private var requiresSpeechConfirmation = false
    func requireSpeechConfirmation() { lock.lock(); requiresSpeechConfirmation = true; lock.unlock() }
    init(output: @escaping ([String: Any]) -> Void) {
        self.output = output
        fft = vDSP_DFT_zop_CreateSetup(nil, 512, .FORWARD)
        vDSP_hann_window(&window, 512, Int32(vDSP_HANN_NORM))
        let mel = { (hz: Double) in 2595 * log10(1 + hz / 700) }
        let hz = { (m: Double) in 700 * (pow(10, m / 2595) - 1) }
        let low = mel(80), high = mel(7600)
        let bins = (0..<28).map { Int((513 * hz(low + Double($0) * (high - low) / 27) / 16000).rounded(.down)) }
        for i in 0..<26 {
            var weights = [Float](repeating: 0, count: 257)
            for k in max(0, bins[i])...min(256, bins[i + 2]) {
                let value = k <= bins[i + 1] ? Double(k - bins[i]) / Double(max(1, bins[i + 1] - bins[i])) : Double(bins[i + 2] - k) / Double(max(1, bins[i + 2] - bins[i + 1]))
                weights[k] = Float(max(0, value))
            }
            filters.append(weights)
        }
        dct = (1...13).map { k in (0..<26).map { Float(cos(Double.pi * Double(k) * (Double($0) + 0.5) / 26)) } }
    }
    deinit { if let fft { vDSP_DFT_DestroySetup(fft) } }
    func speechDetected(_ on: Bool) { lock.lock(); if on { confirmedAt = ProcessInfo.processInfo.systemUptime }; lock.unlock() }
    func process(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return }
        let step = buffer.format.sampleRate / 16000, count = Int(buffer.frameLength)
        var position = 0.0
        while Int(position) < count {
            samples.append(channel[min(count - 1, Int(position))]); position += step
        }
        consume()
    }
    private func consume() {
        guard let fft else { return }
        while samples.count >= 512 {
            let frame = Array(samples.prefix(512)); samples.removeFirst(160)
            frames += 1
            let energy = sqrt(frame.reduce(Float(0)) { $0 + $1 * $1 } / 512)
            if energy < noise * 2 { noise = 0.98 * noise + 0.02 * energy }
            guard energy > max(0.003, noise * 2.5) else { maybeEmit(); continue }
            var best: Float = 0, bestLag = 0
            for lag in stride(from: 40, through: 228, by: 2) {
                var cross: Float = 0, a: Float = 0, b: Float = 0
                for i in 0..<(512 - lag) { cross += frame[i] * frame[i + lag]; a += frame[i] * frame[i]; b += frame[i + lag] * frame[i + lag] }
                let score = cross / max(1e-9, sqrt(a * b))
                if score > best { best = score; bestLag = lag }
            }
            guard best > 0.3, bestLag > 0 else { maybeEmit(); continue }
            voiceFrames += 1; pitches.append(log(16000 / Double(bestLag)))
            var real = [Float](repeating: 0, count: 512), imaginary = real, outReal = real, outImaginary = real
            for i in 0..<512 { real[i] = (frame[i] - (i > 0 ? 0.97 * frame[i - 1] : 0)) * window[i] }
            vDSP_DFT_Execute(fft, &real, &imaginary, &outReal, &outImaginary)
            var power = [Float](repeating: 0, count: 257)
            for i in 0..<257 { power[i] = outReal[i] * outReal[i] + outImaginary[i] * outImaginary[i] }
            var melEnergy = [Float]()
            for weights in filters { var sum: Float = 0; vDSP_dotpr(power, 1, weights, 1, &sum, 257); melEnergy.append(log(max(Float(1e-10), sum))) }
            var cepstrum = [Double]()
            for weights in dct { var sum: Float = 0; for i in 0..<26 { sum += weights[i] * melEnergy[i] }; cepstrum.append(Double(sum)) }
            coefficients.append(cepstrum)
            maybeEmit()
        }
    }
    private func normalized(_ values: [Double]) -> [Double] {
        let length = sqrt(values.reduce(0) { $0 + $1 * $1 }); return values.map { $0 / max(1e-9, length) }
    }
    private func maybeEmit() {
        guard frames >= 40 else { return }
        defer { frames = 0; voiceFrames = 0; coefficients.removeAll(keepingCapacity: true); pitches.removeAll(keepingCapacity: true) }
        guard coefficients.count >= 12 else { return }
        let count = Double(coefficients.count)
        let mean = (0..<13).map { index in coefficients.reduce(0) { $0 + $1[index] } / count }
        let deviation = (0..<13).map { index in sqrt(coefficients.reduce(0) { $0 + pow($1[index] - mean[index], 2) } / count) }
        let pitch = pitches.reduce(0, +) / Double(max(1, pitches.count))
        let quality = Double(voiceFrames) / Double(frames)
        let vector = normalized(normalized(mean) + normalized(deviation).map { $0 * 0.45 } + [pitch * 0.08, quality * 0.1])
        lock.lock(); let speech = !requiresSpeechConfirmation || ProcessInfo.processInfo.systemUptime - confirmedAt < 1.5; lock.unlock()
        output(["t": "voiceFeatures", "vector": vector, "frames": voiceFrames, "quality": quality, "durationMs": frames * 10, "speech": speech])
    }
    static func selfTest(_ output: ([String: Any]) -> Void) {
        let started = ProcessInfo.processInfo.systemUptime
        var results = [[String: Any]]()
        let features = SpeakerFeatures { results.append($0) }
        for chunk in 0..<200 {
            let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 800)!
            buffer.frameLength = 800
            for i in 0..<800 { let t = Double(chunk * 800 + i) / 16000; buffer.floatChannelData![0][i] = Float(0.15 * sin(2 * Double.pi * 130 * t) + 0.05 * sin(2 * Double.pi * 650 * t)) }
            features.process(buffer)
        }
        let vectors = results.compactMap { $0["vector"] as? [Double] }
        output(["ok": !vectors.isEmpty && vectors.allSatisfy { $0.count == 28 && $0.allSatisfy(\.isFinite) }, "dimension": 28, "vectors": vectors.count,
                "inputSeconds": 10, "processingMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000)])
    }
}
