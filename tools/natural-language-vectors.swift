import Foundation
import NaturalLanguage

let languages: [String: NLLanguage] = ["zh": .simplifiedChinese, "en": .english]
var embeddings: [String: NLEmbedding] = [:]
for (key, language) in languages {
    if let model = NLEmbedding.sentenceEmbedding(for: language) { embeddings[key] = model }
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let item = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = item["id"] as? String,
          let language = item["language"] as? String,
          let text = item["text"] as? String,
          let model = embeddings[language],
          let vector = model.vector(for: text) else {
        FileHandle.standardError.write(Data("vector input unavailable\n".utf8))
        continue
    }
    var bytes = Data(capacity: vector.count * 4)
    for value in vector {
        var bits = Float(value).bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { bytes.append(contentsOf: $0) }
    }
    let output: [String: Any] = ["id": id, "language": language, "dimension": vector.count, "float32le": bytes.base64EncodedString()]
    if let encoded = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]),
       let result = String(data: encoded, encoding: .utf8) {
        print(result)
    }
}
