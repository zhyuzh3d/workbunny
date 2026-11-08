import Foundation

// SpeechTranscriber results describe audio ranges, not cumulative sentences.
// A final phrase does not end the input stream. Revisions replace only their
// overlapping volatile range; earlier finalized phrases remain intact.
struct SpeechTranscript {
    struct Segment { let start: Double; let end: Double; let text: String }
    struct Observation { let accepted: Bool; let removedSegments: Int; let touchesFinalized: Bool }
    private(set) var segments: [Segment] = []
    private var finalizedThrough = 0.0
    var text: String { segments.map { $0.text }.joined() }
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
