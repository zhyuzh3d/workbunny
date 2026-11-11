import Foundation

// The raw direct decision excludes WebRTC's generated continuity/hangover.
// These ranges never remove PCM or rewrite recognized words.
struct SpeechAcousticFrame {
    let start: Double
    let end: Double
    let active: Bool
}

// System ASR owns words. Independent sample-clock support can authorize an
// immediate interruption; it cannot prove speaker identity, intent or truth.
struct SpeechAcousticEvidence {
    struct Capture { let start: Double; let end: Double; let at: Double }
    private(set) var duration = 0.0
    private var captures: [Capture] = []
    private var frames: [SpeechAcousticFrame] = []
    // This is only a transient guard: the existing silent PCM fixtures contain
    // isolated direct runs up to 50ms. Six 10ms frames exclude those, without
    // treating hangover as new evidence. Other environmental sounds can exceed
    // 60ms, so this is not a human-speech classifier or a microphone gain gate.
    static let minimumDirectSeconds = 0.06
    mutating func append(seconds: Double, capturedAt: Double, classified: [SpeechAcousticFrame] = []) {
        guard seconds.isFinite, seconds > 0 else { return }
        let start = duration
        duration += seconds
        if capturedAt.isFinite, capturedAt >= seconds { captures.append(Capture(start: start, end: duration, at: capturedAt)) }
        for frame in classified {
            guard frame.start.isFinite, frame.end.isFinite, frame.end > frame.start,
                  frame.start >= -0.01, frame.end <= seconds + 0.000001 else { continue }
            let from = max(0, start + frame.start), to = min(duration, start + frame.end)
            guard to > from, frames.last.map({ from + 0.000001 >= $0.end }) ?? true else { continue }
            if let last = frames.last, last.active == frame.active, abs(last.end - from) <= 0.000001 {
                frames[frames.count - 1] = SpeechAcousticFrame(start: last.start, end: to, active: frame.active)
            } else { frames.append(SpeechAcousticFrame(start: from, end: to, active: frame.active)) }
        }
        let cutoff = duration - 120
        if cutoff > 0 {
            captures.removeAll { $0.end < cutoff }
            frames.removeAll { $0.end < cutoff }
        }
    }
    func contains(start: Double, end: Double) -> Bool {
        start.isFinite && end.isFinite && start >= 0 && end > start && end <= duration + 0.000001
    }
    func supports(start: Double, end: Double) -> Bool {
        guard contains(start: start, end: end) else { return false }
        // A sustained run must actually lie in this result's audio range.
        // Isolated hits or earlier speech cannot authenticate a later range.
        // No per-word duration, text-length or lexical requirement is imposed.
        return frames.contains { frame in
            frame.active && min(end, frame.end) - max(start, frame.start) + 0.000001 >= Self.minimumDirectSeconds
        }
    }
    func captureRange(start: Double, end: Double) -> (Double, Double)? {
        guard contains(start: start, end: end) else { return nil }
        let matching = captures.filter { $0.start < end && start < $0.end }
        guard let first = matching.first, let last = matching.last else { return nil }
        let from = first.at - (first.end - max(start, first.start))
        let to = last.at - (last.end - min(end, last.end))
        guard from >= 0, to >= from else { return nil }
        return (from, to)
    }
}

// SpeechTranscriber results describe audio ranges, not cumulative sentences.
// A final phrase does not end the input stream. Revisions replace only their
// overlapping volatile range; earlier finalized phrases remain intact.
struct SpeechTranscript {
    struct Segment { let start: Double; let end: Double; let text: String }
    struct Observation { let accepted: Bool; let removedSegments: Int; let touchesFinalized: Bool }
    private(set) var segments: [Segment] = []
    private var finalizedThrough = 0.0
    private(set) var validRevisions = true
    var text: String { segments.map { $0.text }.joined() }
    var range: (Double, Double)? {
        guard let first = segments.first, let last = segments.last else { return nil }
        return (first.start, last.end)
    }
    var confirmed: Bool { validRevisions && segments.allSatisfy { $0.end <= finalizedThrough + 0.000001 } }
    // Call only after this generation's end-of-input finalizer succeeded AND
    // its results sequence drained normally. SpeechModuleResult permits an
    // unchanged volatile result to become final without publishing it again;
    // the last per-result watermark alone cannot confirm complete finalization.
    // The receipt covers only audio actually offered to this Analyzer.
    @discardableResult
    mutating func completeFinalization(through inputEnd: Double) -> Bool {
        guard validRevisions, inputEnd.isFinite, inputEnd >= 0, segments.allSatisfy({
            $0.start.isFinite && $0.end.isFinite && $0.start >= 0 &&
            $0.end > $0.start && $0.end <= inputEnd + 0.000001
        }) else { return false }
        finalizedThrough = max(finalizedThrough, inputEnd)
        return confirmed
    }
    @discardableResult
    mutating func accept(text: String, start: Double, end: Double, finalizedThrough: Double, observing: Bool = false, inputEnd: Double? = nil) -> Observation? {
        guard start.isFinite, end.isFinite, start >= 0, end >= start,
              inputEnd.map({ $0.isFinite && $0 >= 0 && end <= $0 + 0.000001 }) ?? true else {
            validRevisions = false
            return observing ? Observation(accepted: false, removedSegments: 0, touchesFinalized: false) : nil
        }
        let previousCount = segments.count, previousFinalization = self.finalizedThrough
        let tolerance = 0.000001
        let touchesConfirmed = segments.contains { $0.start < previousFinalization && $0.start < end && start < $0.end }
        if segments.contains(where: { abs($0.start - start) <= tolerance && abs($0.end - end) <= tolerance && $0.text == text }) {
            if finalizedThrough.isFinite { self.finalizedThrough = max(self.finalizedThrough, finalizedThrough) }
            return observing ? Observation(accepted: true, removedSegments: 0, touchesFinalized: touchesConfirmed) : nil
        }
        // Adjacent time codes can differ by rounding, but a later revision
        // cannot replace an already finalized phrase. A genuine conflict must
        // invalidate publication instead of silently deleting earlier words.
        // A partially finalized segment also owns its earlier text. Without
        // a precise text/audio split, replacing it could silently drop that
        // confirmed prefix even when the new range starts after the watermark.
        guard !segments.contains(where: { $0.start + tolerance < previousFinalization &&
            $0.start + tolerance < end && start + tolerance < $0.end }) else {
            validRevisions = false
            return observing ? Observation(accepted: false, removedSegments: 0, touchesFinalized: true) : nil
        }
        let rangeStart = start < previousFinalization && start + tolerance >= previousFinalization ? previousFinalization : start
        var touchesFinalized = false
        segments.removeAll {
            guard $0.end > previousFinalization + tolerance else { return false }
            let removed = ($0.start < end && rangeStart < $0.end) || $0.start == rangeStart
            if observing && removed && $0.start < previousFinalization { touchesFinalized = true }
            return removed
        }
        let removedCount = previousCount - segments.count
        if !text.isEmpty { segments.append(Segment(start: rangeStart, end: end, text: text)) }
        segments.sort { $0.start < $1.start }
        if finalizedThrough.isFinite { self.finalizedThrough = max(self.finalizedThrough, finalizedThrough) }
        return observing ? Observation(accepted: true, removedSegments: removedCount, touchesFinalized: touchesFinalized) : nil
    }
}
