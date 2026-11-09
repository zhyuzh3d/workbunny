import Foundation

// Sample-clock evidence belongs to the Analyzer input which actually received
// it. It never removes or edits audio. Recognition alone cannot turn quiet or
// unclassified audio into speech, and one 10ms VAD hit is not enough support.
struct SpeechAcousticFrame {
    let start: Double
    let end: Double
    let active: Bool
}
struct SpeechAcousticEvidence {
    struct Capture { let start: Double; let end: Double; let at: Double }
    private(set) var duration = 0.0
    private var frames: [SpeechAcousticFrame] = []
    private var captures: [Capture] = []
    // Six directly classified 10ms frames, excluding the detector's generated
    // hangover. Brief impulses can produce 30ms of direct hits plus an 80ms
    // tail; that tail preserves endpoints but supplies no additional speech.
    let minimumActiveSeconds = 0.06
    mutating func append(seconds: Double, capturedAt: Double, classified: [SpeechAcousticFrame]) {
        guard seconds.isFinite, seconds > 0 else { return }
        let start = duration
        duration += seconds
        if capturedAt.isFinite, capturedAt >= seconds { captures.append(Capture(start: start, end: duration, at: capturedAt)) }
        for frame in classified {
            let from = max(0, start + frame.start), to = min(duration, start + frame.end)
            guard from.isFinite, to.isFinite, to > from else { continue }
            if let last = frames.last, last.active == frame.active, abs(last.end - from) < 0.000001 {
                frames[frames.count - 1] = SpeechAcousticFrame(start: last.start, end: to, active: frame.active)
            } else { frames.append(SpeechAcousticFrame(start: from, end: to, active: frame.active)) }
        }
        // An indefinitely quiet listener must not retain an unbounded clock
        // history. Results outside this retained evidence cannot be accepted.
        let cutoff = duration - 120
        if cutoff > 0 {
            frames.removeAll { $0.end < cutoff }
            captures.removeAll { $0.end < cutoff }
        }
    }
    func supports(start: Double, end: Double) -> Bool {
        guard start.isFinite, end.isFinite, start >= 0, end > start, start < duration else { return false }
        // A word may occupy only part of a confirmed speech run. Nearby
        // isolated impulses cannot be summed into a fictitious utterance.
        return frames.contains { $0.active && $0.end - $0.start + 0.000001 >= minimumActiveSeconds &&
            max(0, min(end, $0.end) - max(start, $0.start)) + 0.000001 >= min(0.03, end - start) }
    }
    func captureRange(start: Double, end: Double) -> (Double, Double)? {
        guard start.isFinite, end.isFinite, end > start else { return nil }
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
    var text: String { segments.map { $0.text }.joined() }
    var range: (Double, Double)? {
        guard let first = segments.first, let last = segments.last else { return nil }
        return (first.start, last.end)
    }
    var confirmed: Bool { segments.allSatisfy { $0.end <= finalizedThrough + 0.000001 } }
    @discardableResult
    mutating func accept(text: String, start: Double, end: Double, finalizedThrough: Double, observing: Bool = false) -> Observation? {
        guard start.isFinite, end.isFinite, end >= start else {
            return observing ? Observation(accepted: false, removedSegments: 0, touchesFinalized: false) : nil
        }
        let previousCount = segments.count, previousFinalization = self.finalizedThrough
        var touchesFinalized = false
        segments.removeAll {
            let removed = ($0.start < end && start < $0.end) || $0.start == start
            if observing && removed && $0.start < previousFinalization { touchesFinalized = true }
            return removed
        }
        let removedCount = previousCount - segments.count
        if !text.isEmpty { segments.append(Segment(start: start, end: end, text: text)) }
        segments.sort { $0.start < $1.start }
        if finalizedThrough.isFinite { self.finalizedThrough = max(self.finalizedThrough, finalizedThrough) }
        return observing ? Observation(accepted: true, removedSegments: removedCount, touchesFinalized: touchesFinalized) : nil
    }
}
