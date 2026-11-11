import Foundation

// macOS 26 may terminate the result stream with this exact rejection after
// the system VAD drains an empty segment. Code 1 alone is a generic internal
// error; this narrow compatibility case still requires finalizer success.
func isEmptySpeechRejection(_ error: Error, detectorEnabled: Bool, current: Bool, endingQuiet: Bool,
                            requested: Bool, inputSeconds: Double, everHadText: Bool,
                            textEmpty: Bool, validRevisions: Bool) -> Bool {
    let error = error as NSError
    return detectorEnabled && current && endingQuiet && requested && inputSeconds.isFinite && inputSeconds > 0 &&
        !everHadText && textEmpty && validRevisions && error.domain == "SFSpeechErrorDomain" && error.code == 1 &&
        error.userInfo[NSLocalizedDescriptionKey] as? String == "RecogRejected"
}

// Transport arrival and VAD sample time have different clocks/latencies.
// Reuse existing health/freshness bounds instead of allowing stale sample
// evidence to misclassify a missing physical stream as a speech failure.
enum SpeechCaptureFault: String {
    case configurationChanged = "configuration-changed"
    case transportTimeout = "transport-timeout"
    case vadTimeout = "vad-timeout"

    var exitCode: Int32 { self == .vadTimeout ? 25 : 22 }
    func message(pendingText: Bool) -> String {
        let base: String
        switch self {
        case .configurationChanged: base = "音频连接已变化，正在重新连接"
        case .transportTimeout: base = "麦克风音频输入中断，正在重新连接"
        case .vadTimeout: base = "语音活动检测暂时不可用，正在重新连接"
        }
        return pendingText ? base + "；本段语音尚未确认，请重新说出完整要求" : base
    }
}
struct SpeechCaptureHealthPolicy {
    static func fault(now: Double, captureAt: Double, activityAt: Double,
                      captureTimeout: Double = 4, activityTimeout: Double = 4,
                      freshness: Double = 0.5) -> SpeechCaptureFault? {
        guard now.isFinite, captureAt.isFinite, activityAt.isFinite,
              now >= captureAt, now >= activityAt else { return .transportTimeout }
        let captureAge = now - captureAt
        if captureAge > captureTimeout { return .transportTimeout }
        guard now - activityAt >= activityTimeout else { return nil }
        return captureAge > freshness ? .transportTimeout : .vadTimeout
    }
}

// Pure policies. The caller protects mutation and claim with its state lock.
// All times use one monotonic clock; absence of evidence is never quiet.
struct SpeechEndpointPolicy {
    enum Activity: String { case unknown, active, quiet }
    enum Decision: String { case wait, quiet, unconfirmed }

    let generation: Int
    let silenceSeconds: Double
    let maxSeconds: Double
    let freshnessSeconds: Double
    let vadHealthTimeoutSeconds: Double
    private let validConfiguration: Bool
    private(set) var healthAt: Double
    private(set) var firstTextAt: Double?
    private(set) var lastTextChangeAt: Double?
    private(set) var hasObservedActive = false
    private(set) var hasText = false
    private var text = ""
    private var activity: Activity = .unknown
    private var observedAt: Double?
    private var quietSeconds = 0.0
    private var quietResetAt: Double?

    init(generation: Int, silenceMs: Double, maxSeconds: Double,
         freshnessSeconds: Double = 0.5,
         startedAt: Double = ProcessInfo.processInfo.systemUptime,
         vadHealthTimeoutSeconds: Double = 4) {
        self.generation = generation
        self.silenceSeconds = silenceMs / 1000
        self.maxSeconds = maxSeconds
        self.freshnessSeconds = freshnessSeconds
        self.vadHealthTimeoutSeconds = vadHealthTimeoutSeconds
        self.healthAt = startedAt
        self.validConfiguration = startedAt.isFinite && startedAt >= 0 &&
            silenceMs.isFinite && silenceMs > 0 && maxSeconds.isFinite && maxSeconds > 0 &&
            freshnessSeconds.isFinite && freshnessSeconds > 0 &&
            vadHealthTimeoutSeconds.isFinite && vadHealthTimeoutSeconds > 0
    }

    @discardableResult
    mutating func recordText(_ value: String, at: Double, generation: Int) -> Bool {
        guard generation == self.generation, at.isFinite, at >= 0,
              lastTextChangeAt == nil || at >= lastTextChangeAt!, value != text else { return false }
        text = value
        hasText = !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        lastTextChangeAt = at
        if hasText && firstTextAt == nil { firstTextAt = at }
        return true
    }

    // Intentional capture suspension is not evidence that VAD has failed or
    // that the owner stopped speaking. Keep text and its original max deadline.
    @discardableResult
    mutating func resetActivity(at: Double, generation: Int) -> Bool {
        guard generation == self.generation, at.isFinite, at >= healthAt else { return false }
        activity = .unknown
        observedAt = nil
        quietSeconds = 0
        quietResetAt = at
        hasObservedActive = false
        healthAt = at
        lastTextChangeAt = at
        return true
    }

    // quietSeconds is measured by the audio detector, not inferred from text.
    @discardableResult
    mutating func observe(_ value: Activity, quietSeconds: Double, at: Double,
                          generation: Int, now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
        guard generation == self.generation else { return false }
        guard at.isFinite, now.isFinite, at >= 0, at <= now,
              observedAt == nil || at >= observedAt! else { return false }
        observedAt = at
        guard now - at <= freshnessSeconds, quietSeconds.isFinite, quietSeconds >= 0 else {
            activity = .unknown; self.quietSeconds = 0; quietResetAt = at; return false
        }
        activity = value
        if value != .unknown { healthAt = max(healthAt, at) }
        switch value {
        case .active:
            hasObservedActive = true
            self.quietSeconds = 0
            quietResetAt = at
        case .unknown:
            self.quietSeconds = 0
            quietResetAt = at
        case .quiet:
            // A stale cumulative counter cannot carry quiet across active or
            // explicitly unknown evidence, even if the producer forgot reset.
            self.quietSeconds = min(quietSeconds, max(0, at - (quietResetAt ?? (at - quietSeconds))))
        }
        return true
    }

    func evidence(at now: Double, generation: Int) -> Activity {
        guard generation == self.generation, now.isFinite, let at = observedAt,
              now >= at, now - at <= freshnessSeconds else { return .unknown }
        return activity
    }

    func allowsEmptyCheckpoint(deliveredSeconds: Double, at now: Double, generation: Int) -> Bool {
        validConfiguration && generation == self.generation && deliveredSeconds.isFinite && deliveredSeconds > 0 &&
        hasObservedActive && evidence(at: now, generation: generation) == .quiet
    }

    func decision(at now: Double, generation: Int) -> Decision {
        guard generation == self.generation else { return .wait }
        guard validConfiguration, now.isFinite, now >= healthAt else { return .unconfirmed }
        if now - healthAt >= vadHealthTimeoutSeconds { return .unconfirmed }
        // A successor may observe a brief sound without recognizing words.
        // It still needs a real finalizer/results barrier to cover that audio;
        // otherwise the host can never confirm the preceding spoken turn.
        if (hasObservedActive || hasText), evidence(at: now, generation: generation) == .quiet,
           quietSeconds + 1e-9 >= silenceSeconds,
           (hasObservedActive || (lastTextChangeAt.map({ now - $0 + 1e-9 >= silenceSeconds }) ?? true)) { return .quiet }
        if let first = firstTextAt, now - first >= maxSeconds { return .unconfirmed }
        return .wait
    }
}

struct SpeechFinalizationBarrier {
    enum Failure: String { case finalizer, results, unconfirmed, unexpectedResultsEnd, unexpectedFinalizer, timeout }
    let generation: Int
    private(set) var requestedAt: Double?
    private(set) var failure: Failure?
    private(set) var claimed = false
    private(set) var resultsConfirmed: Bool?
    private var finalizerOK = false
    private var streamEnded = false
    private var text: String?

    init(generation: Int) { self.generation = generation }

    @discardableResult
    mutating func request(at: Double, generation: Int) -> Bool {
        guard generation == self.generation, !claimed, failure == nil,
              requestedAt == nil, at.isFinite, at >= 0 else { return false }
        requestedAt = at; return true
    }

    @discardableResult
    mutating func finalizerSucceeded(generation: Int) -> Bool {
        guard generation == self.generation, !claimed, failure == nil else { return false }
        guard requestedAt != nil else { failure = .unexpectedFinalizer; return false }
        finalizerOK = true; return true
    }

    @discardableResult
    mutating func resultsEnded(confirmed: Bool, text: String, generation: Int) -> Bool {
        guard generation == self.generation, !claimed, failure == nil else { return false }
        guard requestedAt != nil else { failure = .unexpectedResultsEnd; return false }
        if streamEnded { return false }
        // This is the watermark in the last published result, not a receipt
        // from finalizeAndFinishThroughEndOfInput. An unchanged volatile
        // result need not be republished when it is finalized. Retain this
        // observation for diagnostics and wait for the successful finalizer.
        resultsConfirmed = confirmed
        streamEnded = true; self.text = text; return true
    }

    mutating func fail(_ reason: Failure, generation: Int) {
        guard generation == self.generation, !claimed, failure == nil else { return }
        failure = reason
    }

    @discardableResult
    mutating func timeout(generation: Int) -> Bool {
        // Receipts and publication are separate scheduled jobs. Once both
        // receipts arrived, a timer running before claim must not revoke them.
        guard generation == self.generation, requestedAt != nil, !claimed,
              failure == nil, !(finalizerOK && streamEnded) else { return false }
        failure = .timeout; return true
    }

    // This is an atomic once-claim only when the caller holds its state lock.
    mutating func claim(generation: Int) -> String? {
        guard generation == self.generation, !claimed, failure == nil,
              requestedAt != nil, finalizerOK, streamEnded, let text else { return nil }
        claimed = true; return text
    }
}

extension SpeechEndpointPolicy {
    // No audio, Speech framework, device, files, model, locale or assets.
    static func selfTest() throws -> [String: Any] {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool) throws {
            checks += 1
            if !condition() { throw NSError(domain: "bunny.speech-endpoint-selftest", code: checks) }
        }
        func policy(max: Double = 45) -> SpeechEndpointPolicy {
            SpeechEndpointPolicy(generation: 7, silenceMs: 900, maxSeconds: max, startedAt: 0)
        }
        func observe(_ state: Activity, _ seconds: Double, _ at: Double, _ value: inout SpeechEndpointPolicy) {
            value.observe(state, quietSeconds: seconds, at: at, generation: 7, now: at)
        }

        var value = policy()
        try check(value.decision(at: 0, generation: 7) == .wait)
        value.recordText("fixture text", at: 0, generation: 7)
        observe(.active, 0, 0, &value); observe(.active, 0, 1, &value)
        try check(value.decision(at: 1, generation: 7) == .wait)
        observe(.quiet, 0.4, 1.4, &value)
        try check(value.decision(at: 1.4, generation: 7) == .wait)
        observe(.active, 0, 1.5, &value); observe(.quiet, 1, 1.6, &value)
        try check(value.decision(at: 1.6, generation: 7) == .wait)
        observe(.quiet, 0.9, 2.4, &value)
        try check(value.decision(at: 2.4, generation: 7) == .quiet)
        // A delayed ASR revision must not restart an already elapsed acoustic
        // pause; the finalizer still drains and confirms the system result.
        value.recordText("fixture revised", at: 2.4, generation: 7)
        try check(value.decision(at: 2.4, generation: 7) == .quiet)
        try check(value.evidence(at: 2.91, generation: 7) == .unknown)
        try check(value.decision(at: 2.91, generation: 7) == .wait)
        try check(!value.recordText("fixture revised", at: 2.92, generation: 7))
        try check(value.lastTextChangeAt == 2.4)
        try check(!value.observe(.active, quietSeconds: 0, at: 3, generation: 6, now: 3))
        try check(value.evidence(at: 3, generation: 6) == .unknown)
        try check(value.decision(at: 3, generation: 6) == .wait)
        observe(.unknown, 0, 3, &value)
        try check(value.decision(at: 3, generation: 7) == .wait)
        observe(.quiet, 1, 3.1, &value)
        try check(value.decision(at: 3.1, generation: 7) == .wait)

        var idle = policy()
        for second in 0...60 { observe(.quiet, Double(second), Double(second), &idle) }
        try check(idle.decision(at: 60, generation: 7) == .wait)
        var empty = policy()
        observe(.active, 0, 1, &empty)
        observe(.quiet, 0.8, 1.8, &empty)
        try check(empty.decision(at: 1.8, generation: 7) == .wait)
        observe(.quiet, 1, 2, &empty)
        try check(!empty.hasText && empty.decision(at: 2, generation: 7) == .quiet)
        idle.recordText("fixture hallucination", at: 59, generation: 7)
        try check(idle.decision(at: 60, generation: 7) == .quiet)
        observe(.unknown, 0, 60.1, &idle)
        try check(idle.decision(at: 60.1, generation: 7) == .wait)
        var blind = policy()
        try check(blind.decision(at: 4, generation: 7) == .unconfirmed)
        observe(.unknown, 0, 3.9, &blind)
        try check(blind.healthAt == 0)
        try check(blind.decision(at: 4, generation: 7) == .unconfirmed)
        var stale = policy()
        stale.observe(.quiet, quietSeconds: 10, at: 0.1, generation: 7, now: 3.9)
        try check(stale.healthAt == 0)
        try check(stale.evidence(at: 3.9, generation: 7) == .unknown)
        try check(stale.decision(at: 4, generation: 7) == .unconfirmed)
        var talking = policy(max: 3)
        observe(.active, 0, 2, &talking)
        try check(talking.decision(at: 2, generation: 7) == .wait)
        talking.recordText("fixture ongoing", at: 2, generation: 7)
        observe(.active, 0, 4.9, &talking)
        try check(talking.decision(at: 4.9, generation: 7) == .wait)
        observe(.active, 0, 5, &talking)
        try check(talking.decision(at: 5, generation: 7) == .unconfirmed)

        var resumed = policy(max: 3)
        resumed.recordText("fixture retained", at: 1, generation: 7)
        observe(.active, 0, 1, &resumed); observe(.quiet, 1, 2, &resumed)
        try check(resumed.decision(at: 2, generation: 7) == .quiet)
        try check(resumed.resetActivity(at: 2.1, generation: 7))
        try check(resumed.healthAt == 2.1 && resumed.lastTextChangeAt == 2.1)
        try check(resumed.hasText && resumed.firstTextAt == 1 && !resumed.hasObservedActive)
        try check(resumed.evidence(at: 2.1, generation: 7) == .unknown)
        try check(resumed.decision(at: 2.1, generation: 7) == .wait)
        observe(.quiet, 10, 3, &resumed)
        try check(resumed.decision(at: 3, generation: 7) == .quiet)
        try check(!resumed.recordText("fixture retained", at: 3.1, generation: 7))
        try check(resumed.lastTextChangeAt == 2.1)
        try check(!resumed.resetActivity(at: 3.2, generation: 6))
        observe(.active, 0, 3.9, &resumed)
        try check(resumed.decision(at: 4, generation: 7) == .unconfirmed)
        var resumedIdle = policy()
        resumedIdle.resetActivity(at: 10, generation: 7)
        try check(resumedIdle.decision(at: 13.99, generation: 7) == .wait)
        try check(resumedIdle.decision(at: 14, generation: 7) == .unconfirmed)

        for finalizerFirst in [false, true] {
            var barrier = SpeechFinalizationBarrier(generation: 7)
            try check(barrier.request(at: 1, generation: 7))
            if finalizerFirst { barrier.finalizerSucceeded(generation: 7) }
            else { barrier.resultsEnded(confirmed: true, text: "fixture final", generation: 7) }
            try check(barrier.claim(generation: 7) == nil)
            if finalizerFirst { barrier.resultsEnded(confirmed: true, text: "fixture final", generation: 7) }
            else { barrier.finalizerSucceeded(generation: 7) }
            try check(!barrier.timeout(generation: 7))
            try check(barrier.claim(generation: 6) == nil)
            try check(barrier.claim(generation: 7) == "fixture final")
            try check(barrier.claim(generation: 7) == nil)
        }
        var emptyBarrier = SpeechFinalizationBarrier(generation: 7)
        emptyBarrier.request(at: 1, generation: 7)
        emptyBarrier.resultsEnded(confirmed: true, text: "", generation: 7)
        try check(emptyBarrier.claim(generation: 7) == nil)
        emptyBarrier.finalizerSucceeded(generation: 7)
        try check(emptyBarrier.claim(generation: 7) == "")
        try check(emptyBarrier.claim(generation: 7) == nil)
        for reason in [SpeechFinalizationBarrier.Failure.finalizer, .results, .timeout] {
            var barrier = SpeechFinalizationBarrier(generation: 7)
            barrier.request(at: 1, generation: 7)
            barrier.resultsEnded(confirmed: true, text: "fixture final", generation: 7)
            barrier.fail(reason, generation: 7)
            barrier.finalizerSucceeded(generation: 7)
            try check(barrier.claim(generation: 7) == nil)
        }
        var expired = SpeechFinalizationBarrier(generation: 7)
        expired.request(at: 1, generation: 7)
        expired.finalizerSucceeded(generation: 7)
        expired.resultsEnded(confirmed: true, text: "fixture final", generation: 7)
        try check(!expired.timeout(generation: 7))
        try check(expired.claim(generation: 7) == "fixture final")
        for finalizerFirst in [false, true] {
            var pending = SpeechFinalizationBarrier(generation: 7)
            pending.request(at: 1, generation: 7)
            if finalizerFirst { pending.finalizerSucceeded(generation: 7) }
            else { pending.resultsEnded(confirmed: true, text: "fixture pending", generation: 7) }
            try check(pending.timeout(generation: 7))
            if finalizerFirst { pending.resultsEnded(confirmed: true, text: "fixture pending", generation: 7) }
            else { pending.finalizerSucceeded(generation: 7) }
            try check(pending.claim(generation: 7) == nil)
        }
        // Unchanged volatile results need not be republished as final. Both
        // callback orders still require the complete-input finalizer receipt.
        for finalizerFirst in [false, true] {
            var unchanged = SpeechFinalizationBarrier(generation: 7)
            unchanged.request(at: 1, generation: 7)
            if finalizerFirst { unchanged.finalizerSucceeded(generation: 7) }
            else { unchanged.resultsEnded(confirmed: false, text: "fixture unchanged", generation: 7) }
            try check(unchanged.claim(generation: 7) == nil)
            if finalizerFirst { unchanged.resultsEnded(confirmed: false, text: "fixture unchanged", generation: 7) }
            else { unchanged.finalizerSucceeded(generation: 7) }
            try check(unchanged.resultsConfirmed == false && unchanged.failure == nil)
            try check(unchanged.claim(generation: 7) == "fixture unchanged")
            try check(unchanged.claim(generation: 7) == nil)
        }
        for reason in [SpeechFinalizationBarrier.Failure.finalizer, .results, .timeout] {
            var unconfirmed = SpeechFinalizationBarrier(generation: 7)
            unconfirmed.request(at: 1, generation: 7)
            unconfirmed.resultsEnded(confirmed: false, text: "fixture volatile", generation: 7)
            unconfirmed.fail(reason, generation: 7)
            unconfirmed.finalizerSucceeded(generation: 7)
            try check(unconfirmed.failure == reason && unconfirmed.claim(generation: 7) == nil)
        }
        var unexpected = SpeechFinalizationBarrier(generation: 7)
        unexpected.resultsEnded(confirmed: true, text: "fixture unexpected", generation: 7)
        try check(!unexpected.request(at: 1, generation: 7))
        try check(unexpected.claim(generation: 7) == nil)
        var old = SpeechFinalizationBarrier(generation: 7)
        old.request(at: 1, generation: 7)
        old.finalizerSucceeded(generation: 6)
        old.resultsEnded(confirmed: true, text: "fixture old", generation: 6)
        old.timeout(generation: 6)
        try check(old.failure == nil && old.claim(generation: 7) == nil)
        return ["t": "selfTest", "speechEndpoint": true, "speechFinalizationBarrier": true,
                "unchangedVolatileFinalization": true, "finalizerFailureRejected": true,
                "readyReceiptsSurviveTimeout": true, "checks": checks]
    }
}
