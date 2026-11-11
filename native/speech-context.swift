import Foundation

// Vocabulary is a decoding hint, never a wake-name permission or an audio gate.
// Replacements are snapshotted at the next natural analyzer boundary so a
// settings/tool edit cannot discard the words currently being spoken.
final class SpeechContextStrings {
    struct Snapshot: Equatable { let strings: [String]; let revision: Int }
    private let lock = NSLock()
    private var strings: [String]
    private var revision = 0

    static func normalized(_ values: [String]) -> [String]? {
        guard values.count <= 100 else { return nil }
        var seen = Set<String>(), result: [String] = []
        for value in values {
            let word = value.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !word.isEmpty, word.count <= 64,
                  word.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
            if seen.insert(word.lowercased()).inserted { result.append(word) }
        }
        return result
    }
    static func decode(_ json: String) -> [String]? {
        guard json.utf8.count <= 32768, let data = json.data(using: .utf8),
              let words = try? JSONDecoder().decode([String].self, from: data) else { return nil }
        return normalized(words)
    }
    init(arguments: [String] = CommandLine.arguments) {
        func option(_ flag: String) -> [String]? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return Self.decode(arguments[index + 1])
        }
        // Compatibility only uses the supplied names, never WakeName's
        // generated homophone variants such as 把你.
        strings = option("--context-strings") ?? option("--wake-names") ?? []
    }
    func snapshot() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return Snapshot(strings: strings, revision: revision)
    }
    func replace(json: String) -> Snapshot? {
        guard let values = Self.decode(json) else { return nil }
        lock.lock(); defer { lock.unlock() }
        if values != strings { strings = values; revision += 1 }
        return Snapshot(strings: strings, revision: revision)
    }
}
