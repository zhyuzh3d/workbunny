import Foundation

// Local, text-stage homophone matching. No audio or names are sent to a service.
struct WakeName {
    let names: [String]
    private let tokens: [[String]]
    static func fold(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "zh_CN"))
    }
    static func syllables(_ value: String) -> [String] {
        fold(value.applyingTransform(.toLatin, reverse: false) ?? value).components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }
    init(_ supplied: [String]) {
        var values = supplied.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty && $0.count <= 64 }
        if values.contains(where: { ["bunny", "baby", "bab"].contains($0.lowercased()) }) {
            values += ["Bunny", "Baby", "巴尼", "巴妮", "邦妮", "班尼", "把你", "伴你", "贝比"]
        }
        names = Array(Set(values.prefix(20))).sorted()
        tokens = names.map { WakeName.syllables($0) }
    }
    static let configured: WakeName = {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--wake-names"), i + 1 < args.count,
              let data = args[i+1].data(using: .utf8), let names = try? JSONDecoder().decode([String].self, from: data) else { return WakeName([]) }
        return WakeName(names)
    }()
    func hit(_ raw: String) -> Bool {
        let text = String(raw.prefix(240)).replacingOccurrences(of: "^[\\s，,。.!！?？、:：]+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "^(?:(?:嘿|嗨|喂|你好|那个|请问)[\\s，,。!！、]*){0,2}", with: "", options: .regularExpression)
        let heard = WakeName.syllables(text)
        return tokens.contains { name in !name.isEmpty && heard.count >= name.count && Array(heard.prefix(name.count)) == name }
    }
    static func annotate(_ object: [String:Any]) -> [String:Any] {
        var output = object
        if let type = object["t"] as? String, ["partial", "utterance", "final"].contains(type), let text = object["v"] as? String {
            output["wakeNameHit"] = configured.hit(text)
        }
        return output
    }
    static func selfTest() -> [String:Any] {
        let renamed = WakeName(["倩倩"]), english = WakeName(["Alice", "爱丽丝"]), bunny = WakeName(["Bunny"])
        return ["t":"wakeNameTest", "renamedHomophone":renamed.hit("芊芊，帮我看看"), "renamedExact":renamed.hit("倩倩你好"),
                "middleRejected":!renamed.hit("今天倩倩在工作"), "english":english.hit("Alice, hello"), "englishAlias":english.hit("爱丽丝你好"),
                "bunnyHomophone":bunny.hit("把你，过来一下"), "ordinaryPhraseRejected":!bunny.hit("我把你写的东西保存了"),
                "oldNameRejected":!renamed.hit("巴尼你好")]
    }
}
