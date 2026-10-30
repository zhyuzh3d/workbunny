import Foundation
import Security
import CryptoKit
import Darwin

let maxInputLine = 8192
let maxOutputLine = 8192
let itemService = "workbunny Master Key"
let itemLabel = "workbunny Master Key"
let helperBundleName = "workbunny钥匙"
let helperBundleIdentifier = "cn.haminn.workbunny.keys"
let helperExecutableName = "workbunny-keychain"
let parentExecutableName = "workbunny"

struct HelperIdentity {
    let executable: String
    let bundle: String
    let parent: String
}

func currentExecutablePath(pid: pid_t) -> String? {
    var bytes = [CChar](repeating: 0, count: 4096)
    let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
    guard count > 0 else { return nil }
    return URL(fileURLWithPath: String(cString: bytes)).standardizedFileURL.path
}

func processInfo(pid: pid_t) -> proc_bsdinfo? {
    var info = proc_bsdinfo()
    let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    guard count == MemoryLayout<proc_bsdinfo>.size, info.pbi_pid == UInt32(pid) else { return nil }
    return info
}

func validAccount(_ value: Any?) -> String? {
    guard let account = value as? String, account.hasPrefix("vault-"), account.count == 42 else { return nil }
    let uuid = String(account.dropFirst("vault-".count))
    guard let parsed = UUID(uuidString: uuid), parsed.uuidString.lowercased() == uuid else { return nil }
    return account
}

func helperIdentity() -> HelperIdentity? {
    guard let executable = currentExecutablePath(pid: getpid()) else { return nil }
    let components = URL(fileURLWithPath: executable).pathComponents
    let expectedSuffix = ["Contents", "Resources", "bin", "workbunny-keychain.app", "Contents", "MacOS", helperExecutableName]
    guard components.count > expectedSuffix.count,
          Array(components.suffix(expectedSuffix.count)) == expectedSuffix,
          let outerIndex = components.dropLast(expectedSuffix.count).indices.last,
          outerIndex + 1 + expectedSuffix.count == components.count,
          Array(components[(outerIndex + 1)...]) == expectedSuffix else { return nil }
    let outerApp = NSString.path(withComponents: Array(components[...outerIndex]))
    guard let outer = Bundle(path: outerApp), outer.bundleIdentifier == "cn.haminn.workbunny" else { return nil }
    var helperURL = URL(fileURLWithPath: executable)
    for _ in 0..<3 { helperURL.deleteLastPathComponent() }
    let helperBundle = helperURL.path
    guard let bundle = Bundle(path: helperBundle),
          bundle.object(forInfoDictionaryKey: "CFBundleName") as? String == helperBundleName,
          bundle.bundleIdentifier == helperBundleIdentifier,
          bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == helperExecutableName else { return nil }
    let parent = URL(fileURLWithPath: outerApp).appendingPathComponent("Contents/MacOS/\(parentExecutableName)").standardizedFileURL.path
    return HelperIdentity(executable: executable, bundle: helperBundle, parent: parent)
}

func authorizedParent(_ identity: HelperIdentity) -> Bool {
    guard let ownInfo = processInfo(pid: getpid()), ownInfo.pbi_ppid > 0 else { return false }
    let parentPID = pid_t(ownInfo.pbi_ppid)
    guard let parentInfo = processInfo(pid: parentPID), parentInfo.pbi_pid == UInt32(parentPID),
          let parentPath = currentExecutablePath(pid: parentPID) else { return false }
    guard parentPath == identity.parent else { return false }

    var selfLeaf: Data
#if WORKBUNNY_KEYCHAIN_PARENT_GATE_TESTING
    // Test-only binary: skip its own absent test signature, but still exercise parent identity rejection.
    selfLeaf = Data(repeating: 0, count: 20)
#else
    var selfCode: SecCode?
    guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
          let selfRequirement = makeRequirement(identifier: helperBundleIdentifier),
          SecCodeCheckValidity(selfCode, [], selfRequirement) == errSecSuccess,
          let leaf = leafCertificateHash(for: selfCode) else { return false }
    selfLeaf = leaf
#endif
    guard let parentCode = guestCode(pid: parentPID),
          let parentRequirement = makeRequirement(identifier: "cn.haminn.workbunny", leafSHA1: selfLeaf),
          SecCodeCheckValidity(parentCode, [], parentRequirement) == errSecSuccess else { return false }
    return true
}

func makeRequirement(identifier: String, leafSHA1: Data? = nil) -> SecRequirement? {
    let predicate: String
    if let leafSHA1 {
        let hex = leafSHA1.map { String(format: "%02x", $0) }.joined()
        predicate = "identifier \"\(identifier)\" and certificate leaf = H\"\(hex)\""
    } else {
        predicate = "identifier \"\(identifier)\""
    }
    var requirement: SecRequirement?
    let status = SecRequirementCreateWithString(predicate as CFString, [], &requirement)
    return status == errSecSuccess ? requirement : nil
}

func guestCode(pid: pid_t) -> SecCode? {
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    var code: SecCode?
    let status = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
    return status == errSecSuccess ? code : nil
}

func leafCertificateHash(for code: SecCode) -> Data? {
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let dictionary = info as? [String: Any],
          dictionary[kSecCodeInfoIdentifier as String] as? String != nil,
          let certificates = dictionary[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = certificates.first else { return nil }
    let der = SecCertificateCopyData(leaf) as Data
    return Data(Insecure.SHA1.hash(data: der))
}

func writeAll(_ data: Data) -> Bool {
    var offset = 0
    return data.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return false }
        while offset < raw.count {
            let written = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), raw.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}

func respond(_ object: [String: Any]) -> Bool {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), data.count < maxOutputLine else { return false }
    data.append(10)
    return writeAll(data)
}

func requestDictionary(_ line: Data) -> [String: Any]? {
    guard let value = try? JSONSerialization.jsonObject(with: line), let dict = value as? [String: Any] else { return nil }
    return dict
}

func readItem(account: String) -> (OSStatus, Data?) {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: itemService,
        kSecAttrAccount as String: account,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess else { return (status, nil) }
    guard let data = result as? Data else { return (errSecDecode, nil) }
    return (status, data)
}

func equalKeyConstantTime(_ a: Data, _ b: Data) -> Bool {
    guard a.count == 32, b.count == 32 else { return false }
    var difference: UInt8 = 0
    a.withUnsafeBytes { lhs in
        b.withUnsafeBytes { rhs in
            guard let l = lhs.baseAddress?.assumingMemoryBound(to: UInt8.self),
                  let r = rhs.baseAddress?.assumingMemoryBound(to: UInt8.self) else { difference = 1; return }
            for index in 0..<32 { difference |= l[index] ^ r[index] }
        }
    }
    return difference == 0
}

func makeHelperAccess(bundlePath: String) -> SecAccess? {
    var trustedApp: SecTrustedApplication?
    let trustedStatus = bundlePath.withCString { SecTrustedApplicationCreateFromPath($0, &trustedApp) }
    guard trustedStatus == errSecSuccess, let trustedApp else { return nil }
    var access: SecAccess?
    let trustedApps = [trustedApp] as CFArray
    let accessStatus = SecAccessCreate(itemLabel as CFString, trustedApps, &access)
    guard accessStatus == errSecSuccess else { return nil }
    return access
}

func addItem(_ key: Data, account: String, bundlePath: String) -> OSStatus {
    guard let access = makeHelperAccess(bundlePath: bundlePath) else { return errSecAuthFailed }
    let attributes: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: itemService,
        kSecAttrAccount as String: account,
        kSecAttrLabel as String: itemLabel,
        kSecAttrAccess as String: access,
        kSecValueData as String: key,
    ]
    return SecItemAdd(attributes as CFDictionary, nil)
}

func base64Key(_ value: Any?) -> Data? {
    guard let encoded = value as? String, encoded.utf8.count == 44,
          let data = Data(base64Encoded: encoded), data.count == 32,
          data.base64EncodedString() == encoded else { return nil }
    return data
}

func handle(_ request: [String: Any], identity: HelperIdentity) -> [String: Any] {
    guard let op = request["op"] as? String else { return ["ok": false, "error": "invalid_request"] }
    switch op {
    case "read":
        guard Set(request.keys) == Set(["op", "account"]), let account = validAccount(request["account"]) else { return ["ok": false, "error": "invalid_request"] }
        guard authorizedParent(identity) else { return ["ok": false, "error": "unauthorized"] }
        let (status, data) = readItem(account: account)
        guard authorizedParent(identity) else { return ["ok": false, "error": "unauthorized"] }
        if status == errSecItemNotFound { return ["ok": false, "error": "not_found"] }
        guard status == errSecSuccess, var key = data, key.count == 32 else { return ["ok": false, "error": "keychain_failure"] }
        let encoded = key.base64EncodedString()
        key.resetBytes(in: 0..<key.count)
        return ["ok": true, "key": encoded]
    case "import":
        guard Set(request.keys) == Set(["op", "account", "key"]), let account = validAccount(request["account"]), var incoming = base64Key(request["key"]) else { return ["ok": false, "error": "invalid_request"] }
        defer { incoming.resetBytes(in: 0..<incoming.count) }
        guard authorizedParent(identity) else { return ["ok": false, "error": "unauthorized"] }
        let (status, existing) = readItem(account: account)
        guard authorizedParent(identity) else { return ["ok": false, "error": "unauthorized"] }
        if status == errSecSuccess {
            guard var current = existing, current.count == 32 else { return ["ok": false, "error": "keychain_failure"] }
            let same = equalKeyConstantTime(current, incoming)
            current.resetBytes(in: 0..<current.count)
            return same ? ["ok": true, "already_present": true] : ["ok": false, "error": "key_conflict"]
        }
        guard status == errSecItemNotFound else { return ["ok": false, "error": "keychain_failure"] }
        let addStatus = addItem(incoming, account: account, bundlePath: identity.bundle)
        guard authorizedParent(identity) else { return ["ok": false, "error": "unauthorized"] }
        if addStatus == errSecSuccess { return ["ok": true, "imported": true] }
        if addStatus == errSecDuplicateItem {
            let (retryStatus, retryData) = readItem(account: account)
            guard retryStatus == errSecSuccess, var current = retryData, current.count == 32 else { return ["ok": false, "error": "keychain_failure"] }
            let same = equalKeyConstantTime(current, incoming)
            current.resetBytes(in: 0..<current.count)
            return same ? ["ok": true, "already_present": true] : ["ok": false, "error": "key_conflict"]
        }
        return ["ok": false, "error": "keychain_failure"]
    default:
        return ["ok": false, "error": "invalid_request"]
    }
}

signal(SIGPIPE, SIG_IGN)
guard CommandLine.arguments.count == 1, let identity = helperIdentity() else { exit(64) }

var line = Data()
var oversized = false
while true {
    guard let chunk = try? FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty else { break }
    for byte in chunk {
        if byte == 10 {
            let response: [String: Any]
            if oversized { response = ["ok": false, "error": "request_too_large"] }
            else if !authorizedParent(identity) { response = ["ok": false, "error": "unauthorized"] }
            else if let request = requestDictionary(line) { response = handle(request, identity: identity) }
            else { response = ["ok": false, "error": "invalid_request"] }
            line.removeAll(keepingCapacity: true); oversized = false
            if !respond(response) { exit(1) }
        } else if !oversized {
            if line.count >= maxInputLine { oversized = true }
            else { line.append(byte) }
        }
    }
}
if !line.isEmpty || oversized {
    if !respond(["ok": false, "error": oversized ? "request_too_large" : "invalid_request"]) { exit(1) }
}
