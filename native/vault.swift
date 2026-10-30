import Foundation
import SQLite3
import CoreFoundation
import Darwin
import Security
import CryptoKit

let maxLineBytes = 64 * 1024 * 1024
let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct VaultError: Error { let code: String }
func fail(_ code: String) -> VaultError { VaultError(code: code) }

func json(_ value: Any) -> Data { (try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])) ?? Data("{}".utf8) }
func send(_ value: [String: Any]) {
    var payload=value
    var data=json(payload)
    if data.count > maxLineBytes { payload=["id":value["id"] ?? NSNull(),"ok":false,"error":"response_too_large"]; data=json(payload) }
    data.append(10)
    FileHandle.standardOutput.write(data)
}

// This gate deliberately derives every identity from kernel process APIs.
// It never accepts a caller-supplied PID or path and has no DB/key side effects.
func executablePath(pid: pid_t) -> String? {
    var bytes = [CChar](repeating: 0, count: 4096) // 4 * MAXPATHLEN from libproc's contract.
    let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
    guard count > 0 else { return nil }
    return String(cString: bytes)
}

func processInfo(pid: pid_t) -> proc_bsdinfo? {
    var info = proc_bsdinfo()
    let count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
    guard count == MemoryLayout<proc_bsdinfo>.size, info.pbi_pid == UInt32(pid) else { return nil }
    return info
}

func codeRequirement(identifier: String, leafSHA1: Data? = nil) -> SecRequirement? {
    let text: String
    if let leafSHA1 {
        let hex = leafSHA1.map { String(format: "%02x", $0) }.joined()
        text = "identifier \"\(identifier)\" and certificate leaf = H\"\(hex)\""
    } else {
        text = "identifier \"\(identifier)\""
    }
    var requirement: SecRequirement?
    let status = SecRequirementCreateWithString(text as CFString, [], &requirement)
    return status == errSecSuccess ? requirement : nil
}

func signingLeafSHA1(_ code: SecCode, identifier: String) -> Data? {
    guard let requirement = codeRequirement(identifier: identifier),
          SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return nil }
    var staticCode: SecStaticCode?
    var information: CFDictionary?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [String: Any],
          values[kSecCodeInfoIdentifier as String] as? String == identifier,
          let certificates = values[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = certificates.first else { return nil }
    let der = SecCertificateCopyData(leaf) as Data
    return Data(Insecure.SHA1.hash(data: der))
}

func guestCode(pid: pid_t) -> SecCode? {
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    var code: SecCode?
    let status = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
    return status == errSecSuccess ? code : nil
}

func hasMatchingSignedIdentity(pid: pid_t, identifier: String, leafSHA1: Data) -> Bool {
    guard let code = guestCode(pid: pid),
          let requirement = codeRequirement(identifier: identifier, leafSHA1: leafSHA1) else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
}

func verifyKeyParent() -> Bool {
    let selfPID = getpid()
    guard let selfPath = executablePath(pid: selfPID) else { return false }
    let components = URL(fileURLWithPath: selfPath).standardizedFileURL.pathComponents
    guard components.count >= 6,
          components.last == "vault",
          components.suffix(4).elementsEqual(["Contents", "Resources", "bin", "vault"]),
          let appComponent = components.lastIndex(where: { $0.hasSuffix(".app") }),
          appComponent + 1 < components.count,
          Array(components[(appComponent + 1)...]) == ["Contents", "Resources", "bin", "vault"] else { return false }
    let appPath = NSString.path(withComponents: Array(components[...appComponent]))
    let expectedMain = URL(fileURLWithPath: appPath).appendingPathComponent("Contents/MacOS/workbunny").standardizedFileURL.path

    guard let selfInfo = processInfo(pid: selfPID), selfInfo.pbi_ppid > 0 else { return false }
    let helperPID = pid_t(selfInfo.pbi_ppid)
    guard let helperInfo = processInfo(pid: helperPID), helperInfo.pbi_ppid > 0,
          let helperPath = executablePath(pid: helperPID), helperPath == expectedMain else { return false }
    let mainPID = pid_t(helperInfo.pbi_ppid)
    guard let mainInfo = processInfo(pid: mainPID), mainInfo.pbi_pid == UInt32(mainPID),
          let mainPath = executablePath(pid: mainPID), mainPath == expectedMain else { return false }

    var selfCode: SecCode?
    guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
          let selfLeaf = signingLeafSHA1(selfCode, identifier: "cn.haminn.workbunny.vault"),
          hasMatchingSignedIdentity(pid: helperPID, identifier: "cn.haminn.workbunny", leafSHA1: selfLeaf),
          hasMatchingSignedIdentity(pid: mainPID, identifier: "cn.haminn.workbunny", leafSHA1: selfLeaf) else { return false }
    return true
}

if CommandLine.arguments.dropFirst().first == "--verify-key-parent" {
    let authorized = verifyKeyParent()
    if let data = try? JSONSerialization.data(withJSONObject: ["authorized": authorized], options: [.sortedKeys]),
       let output = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((output + "\n").utf8))
    } else {
        FileHandle.standardOutput.write(Data("{\"authorized\":false}\n".utf8))
    }
    exit(0)
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--inspect-copy" {
    var db: OpaquePointer?
    guard sqlite3_open_v2(URL(fileURLWithPath: CommandLine.arguments[2]).absoluteString + "?immutable=1", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else { exit(3) }
    defer { sqlite3_close(db) }
    func scalar(_ sql: String) -> String? {
        var stmt: OpaquePointer?; guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { return nil }; defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW, let p = sqlite3_column_text(stmt, 0) else { return nil }; return String(cString: p)
    }
    guard scalar("PRAGMA quick_check") == "ok", let count = scalar("SELECT COUNT(*) FROM records"), let version = scalar("PRAGMA user_version") else { exit(4) }
    send(["count": Int(count) ?? 0, "version": Int(version) ?? 0, "integrity": "ok"]); exit(0)
}
final class DB {
    var db: OpaquePointer?
    var restoring = false
    var lockFD: Int32 = -1
    init(path: String) throws {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        guard !FileManager.default.fileExists(atPath: url.deletingLastPathComponent().appendingPathComponent(".migration-snapshot.json").path) else { throw fail("database_moved_snapshot") }
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        lockFD = open(dir.appendingPathComponent(".vault-lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { if lockFD >= 0 { close(lockFD); lockFD = -1 }; throw fail("database_in_use") }
        let rc = sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard rc == SQLITE_OK, let db else { throw fail("database_open_failed") }
        _ = sqlite3_busy_timeout(db, 5000)
        try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;")
        let chmodRC = url.path.withCString { chmod($0, 0o600) }
        guard chmodRC == 0 else { throw fail("database_permissions_failed") }
        let version = try scalarInt("PRAGMA user_version")
        guard version <= 3 else { throw fail("database_version_newer") }
        if version == 0 {
            try exec("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS records(
                  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ts INTEGER NOT NULL,
                  updatedAt INTEGER NOT NULL, state TEXT NOT NULL,
                  expiresAt INTEGER, body TEXT NOT NULL,
                  domain TEXT NOT NULL DEFAULT 'private' CHECK(domain IN ('work','life','private')),
                  visibilityFloor INTEGER NOT NULL DEFAULT 2 CHECK(visibilityFloor BETWEEN 0 AND 2),
                  ingestionSeq INTEGER NOT NULL UNIQUE
                );
                CREATE INDEX IF NOT EXISTS records_kind_state_ts_id_idx ON records(kind,state,ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_state_ts_id_idx ON records(state,ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_ts_id_idx ON records(ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_floor_kind_state_ts_id_idx ON records(visibilityFloor,kind,state,ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_domain_floor_ts_id_idx ON records(domain,visibilityFloor,ts,id);
                CREATE INDEX IF NOT EXISTS records_domain_floor_ingestion_idx ON records(domain,visibilityFloor,ingestionSeq);
                CREATE TABLE IF NOT EXISTS tokens(
                  recordId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                  token TEXT NOT NULL, PRIMARY KEY(recordId, token)
                );
                CREATE INDEX IF NOT EXISTS tokens_token_idx ON tokens(token);
                CREATE TABLE IF NOT EXISTS links(
                  sourceId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                  derivedId TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
                  PRIMARY KEY(sourceId, derivedId), CHECK(sourceId <> derivedId)
                );
                CREATE INDEX IF NOT EXISTS links_derived_idx ON links(derivedId);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                INSERT OR IGNORE INTO meta(key,value) VALUES('epoch',0);
                INSERT OR IGNORE INTO meta(key,value) VALUES('ingestion_seq',0);
                PRAGMA user_version=3;
                COMMIT;
                """)
        } else {
            if version == 1 {
                // Existing rows contain no trustworthy scope metadata. The
                // conservative migration therefore makes every legacy row
                // private and visible only in private mode.
                try exec("BEGIN IMMEDIATE; ALTER TABLE records ADD COLUMN domain TEXT NOT NULL DEFAULT 'private' CHECK(domain IN ('work','life','private')); ALTER TABLE records ADD COLUMN visibilityFloor INTEGER NOT NULL DEFAULT 2 CHECK(visibilityFloor BETWEEN 0 AND 2); PRAGMA user_version=2; COMMIT;")
            }
            let currentVersion = try scalarInt("PRAGMA user_version")
            if currentVersion == 2 {
                // A stable, monotonic ingestion sequence supports maintenance
                // watermarks even when timestamps repeat or the clock moves
                // backwards. Legacy rows receive a deterministic sequence.
                try withTransaction {
                    try exec("ALTER TABLE records ADD COLUMN ingestionSeq INTEGER NOT NULL DEFAULT 0")
                    let select = try statement("SELECT id FROM records ORDER BY ts ASC,id ASC")
                    var ordered: [String] = []
                    while true { let rc = sqlite3_step(select); if rc == SQLITE_DONE { break }; guard rc == SQLITE_ROW else { sqlite3_finalize(select); throw fail("database_operation_failed") }; ordered.append(columnText(select,0)) }
                    sqlite3_finalize(select)
                    var sequence: Int64 = 0
                    for id in ordered {
                        sequence += 1
                        let update = try statement("UPDATE records SET ingestionSeq=? WHERE id=?")
                        bind(update,1,sequence); bind(update,2,id)
                        guard sqlite3_step(update) == SQLITE_DONE else { sqlite3_finalize(update); throw fail("database_operation_failed") }
                        sqlite3_finalize(update)
                    }
                    try exec("INSERT OR REPLACE INTO meta(key,value) VALUES('ingestion_seq',\(sequence)); CREATE UNIQUE INDEX IF NOT EXISTS records_ingestion_seq_idx ON records(ingestionSeq); CREATE INDEX IF NOT EXISTS records_domain_floor_ingestion_idx ON records(domain,visibilityFloor,ingestionSeq); PRAGMA user_version=3")
                }
            } else {
                try exec("INSERT OR IGNORE INTO meta(key,value) VALUES('ingestion_seq',0); CREATE UNIQUE INDEX IF NOT EXISTS records_ingestion_seq_idx ON records(ingestionSeq); CREATE INDEX IF NOT EXISTS records_domain_floor_ingestion_idx ON records(domain,visibilityFloor,ingestionSeq)")
            }
            try exec("CREATE INDEX IF NOT EXISTS records_kind_state_ts_id_idx ON records(kind,state,ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_state_ts_id_idx ON records(state,ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_ts_id_idx ON records(ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_floor_kind_state_ts_id_idx ON records(visibilityFloor,kind,state,ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_domain_floor_ts_id_idx ON records(domain,visibilityFloor,ts,id); CREATE INDEX IF NOT EXISTS tokens_token_idx ON tokens(token); CREATE INDEX IF NOT EXISTS links_derived_idx ON links(derivedId);")
        }
    }
    deinit { if let db { sqlite3_close_v2(db) }; if lockFD >= 0 { flock(lockFD, LOCK_UN); close(lockFD) } }
    func exec(_ sql: String) throws {
        var error: UnsafeMutablePointer<Int8>?
        let rc = sqlite3_exec(db, sql, nil, nil, &error)
        if rc != SQLITE_OK { if let error { sqlite3_free(error) }; throw fail("database_operation_failed") }
    }
    func statement(_ sql: String) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw fail("database_operation_failed") }
        return stmt
    }
    func scalarInt(_ sql: String) throws -> Int64 {
        let s = try statement(sql); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_ROW else { throw fail("database_operation_failed") }
        return sqlite3_column_int64(s, 0)
    }
    func bind(_ s: OpaquePointer, _ index: Int32, _ value: String) { sqlite3_bind_text(s, index, value, -1, transient) }
    func bind(_ s: OpaquePointer, _ index: Int32, _ value: Int64) { sqlite3_bind_int64(s, index, value) }
    func columnText(_ s: OpaquePointer, _ n: Int32) -> String { sqlite3_column_text(s, n).map { String(cString: $0) } ?? "" }
    func epoch() throws -> Int64 { try scalarInt("SELECT value FROM meta WHERE key='epoch'") }
    func nextIngestionSeq() throws -> Int64 {
        try exec("UPDATE meta SET value=value+1 WHERE key='ingestion_seq'")
        return try scalarInt("SELECT value FROM meta WHERE key='ingestion_seq'")
    }
    func existingIngestionSeq(_ id: String) throws -> Int64? {
        let s = try statement("SELECT ingestionSeq FROM records WHERE id=?")
        defer { sqlite3_finalize(s) }; bind(s,1,id)
        guard sqlite3_step(s) == SQLITE_ROW else { return nil }
        return sqlite3_column_int64(s,0)
    }
    func safeSequence(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value.rounded(.towardZero) == value, value >= 1, value <= 9_007_199_254_740_991 else { return nil }
        return number.int64Value
    }
    func advanceIngestionCounter(to sequence: Int64) throws {
        let s = try statement("UPDATE meta SET value=MAX(value,?) WHERE key='ingestion_seq'")
        defer { sqlite3_finalize(s) }; bind(s,1,sequence)
        guard sqlite3_step(s) == SQLITE_DONE, sqlite3_changes(db) == 1 else { throw fail("database_operation_failed") }
    }
    func advanceEpoch() throws -> Int64 { try exec("UPDATE meta SET value=value+1 WHERE key='epoch'"); return try epoch() }
    func exists(_ id: String) throws -> Bool {
        let s=try statement("SELECT 1 FROM records WHERE id=? LIMIT 1"); defer{sqlite3_finalize(s)}
        bind(s,1,id); return sqlite3_step(s)==SQLITE_ROW
    }
    func validHMACToken(_ value: String) -> Bool {
        value.utf8.count == 22 && value.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90) ||
            ($0.value >= 97 && $0.value <= 122) || $0.value == 45 || $0.value == 95
        }
    }
    func tokenFilters(_ p: [String: Any], _ key: String) throws -> [String] {
        guard let raw = p[key] else { return [] }
        guard let values = raw as? [String], values.count <= 8, values.allSatisfy(validHMACToken) else { throw fail("invalid_request") }
        return Array(Set(values))
    }
    func appendTokenFilters(_ required: [String], _ excluded: [String], _ idExpr: String,
                            _ sql: inout String, _ binds: inout [(String?, Int64?)]) {
        for token in required {
            sql += " AND EXISTS(SELECT 1 FROM tokens AS required_token WHERE required_token.recordId=\(idExpr) AND required_token.token=?)"
            binds.append((token,nil))
        }
        for token in excluded {
            sql += " AND NOT EXISTS(SELECT 1 FROM tokens AS excluded_token WHERE excluded_token.recordId=\(idExpr) AND excluded_token.token=?)"
            binds.append((token,nil))
        }
    }
    func validateProspectiveCycles(_ records: [[String: Any]]) throws {
        // Ordinary source-free inserts (messages, most state updates) never
        // touch or scan the graph. Only a changed source set can add a cycle.
        var finalByID: [String: Set<String>] = [:]
        for record in records {
            guard let id = text(record["id"]), let sources = record["sources"] as? [String] else { throw fail("invalid_record") }
            finalByID[id] = Set(sources)
        }
        guard !finalByID.isEmpty else { return }
        let ids = Array(finalByID.keys)
        let marks = Array(repeating: "?", count: ids.count).joined(separator: ",")
        let old = try statement("SELECT derivedId,sourceId FROM links WHERE derivedId IN (\(marks))")
        defer { sqlite3_finalize(old) }
        for (index, id) in ids.enumerated() { bind(old, Int32(index + 1), id) }
        var oldByID: [String: Set<String>] = [:]
        while true {
            let rc = sqlite3_step(old)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw fail("database_operation_failed") }
            oldByID[columnText(old, 0), default: []].insert(columnText(old, 1))
        }
        var changed = Set<String>(), hasAddition = false
        for (id, next) in finalByID {
            let previous = oldByID[id] ?? []
            if previous != next { changed.insert(id) }
            if !next.isSubset(of: previous) { hasAddition = true }
        }
        guard hasAddition else { return } // Edge deletion cannot create a cycle.

        try exec("CREATE TEMP TABLE IF NOT EXISTS staged_link_children(derivedId TEXT PRIMARY KEY); CREATE TEMP TABLE IF NOT EXISTS staged_links(sourceId TEXT NOT NULL,derivedId TEXT NOT NULL,PRIMARY KEY(sourceId,derivedId))")
        try exec("DELETE FROM staged_links; DELETE FROM staged_link_children")
        let childInsert = try statement("INSERT INTO staged_link_children(derivedId) VALUES(?)")
        defer { sqlite3_finalize(childInsert) }
        let linkInsert = try statement("INSERT INTO staged_links(sourceId,derivedId) VALUES(?,?)")
        defer { sqlite3_finalize(linkInsert) }
        for id in changed {
            sqlite3_reset(childInsert); sqlite3_clear_bindings(childInsert); bind(childInsert,1,id)
            guard sqlite3_step(childInsert) == SQLITE_DONE else { throw fail("database_operation_failed") }
            for source in finalByID[id] ?? [] {
                sqlite3_reset(linkInsert); sqlite3_clear_bindings(linkInsert); bind(linkInsert,1,source); bind(linkInsert,2,id)
                guard sqlite3_step(linkInsert) == SQLITE_DONE else { throw fail("database_operation_failed") }
            }
        }
        let cycle = try statement("""
            WITH RECURSIVE reachable(startSource,node) AS (
              SELECT sourceId,derivedId FROM staged_links
              UNION
              SELECT reachable.startSource,links.derivedId FROM reachable
                JOIN links ON links.sourceId=reachable.node
                WHERE links.derivedId NOT IN (SELECT derivedId FROM staged_link_children)
              UNION
              SELECT reachable.startSource,staged_links.derivedId FROM reachable
                JOIN staged_links ON staged_links.sourceId=reachable.node
            )
            SELECT 1 FROM reachable WHERE node=startSource LIMIT 1
            """)
        defer { sqlite3_finalize(cycle) }
        let cycleResult = sqlite3_step(cycle)
        if cycleResult == SQLITE_ROW { throw fail("invalid_source") }
        guard cycleResult == SQLITE_DONE else { throw fail("database_operation_failed") }
    }
    func sceneFloor(_ scene: String) -> Int64? {
        switch scene { case "work": return 0; case "life": return 1; case "private": return 2; default: return nil }
    }
    func requestedSceneFloor(_ p: [String: Any]) throws -> Int64? {
        guard let raw = p["scene"] else { return nil }
        if raw is NSNull { return nil } // Explicit maintenance-only, unfiltered access.
        guard let scene = raw as? String, let floor = sceneFloor(scene) else { throw fail("invalid_request") }
        return floor
    }
    func domainFloor(_ domain: String) -> Int64? {
        switch domain { case "work": return 0; case "life": return 1; case "private": return 2; default: return nil }
    }
    func directDependentsMeetFloor(id: String, floor: Int64, stagedFloors: [String: Int64]) throws -> Bool {
        // Validate the final transaction view, allowing a parent and all of
        // its children to be raised together without exposing a lower-floor
        // edge during commit.
        let q = try statement("SELECT records.id,records.visibilityFloor FROM links JOIN records ON records.id=links.derivedId WHERE links.sourceId=?")
        defer { sqlite3_finalize(q) }; bind(q,1,id)
        while true {
            let rc = sqlite3_step(q)
            if rc == SQLITE_DONE { return true }
            guard rc == SQLITE_ROW else { throw fail("database_operation_failed") }
            let childID = columnText(q,0)
            let childFloor = stagedFloors[childID] ?? sqlite3_column_int64(q,1)
            if childFloor < floor { return false }
        }
    }
    func row(_ s: OpaquePointer) -> [String: Any] {
        var out: [String: Any] = ["id": columnText(s,0), "kind": columnText(s,1), "ts": sqlite3_column_int64(s,2), "updatedAt": sqlite3_column_int64(s,3), "state": columnText(s,4), "body": columnText(s,6), "domain": columnText(s,7), "visibilityFloor": sqlite3_column_int64(s,8), "ingestionSeq": sqlite3_column_int64(s,9)]
        if sqlite3_column_type(s,5) != SQLITE_NULL { out["expiresAt"] = sqlite3_column_int64(s,5) }
        return out
    }
    func rows(_ sql: String, _ bindValues: [(String?, Int64?)]) throws -> [[String: Any]] {
        let s = try statement(sql); defer { sqlite3_finalize(s) }
        for (i, value) in bindValues.enumerated() {
            if let text = value.0 { bind(s, Int32(i+1), text) }
            else if let number = value.1 { bind(s, Int32(i+1), number) }
        }
        var result: [[String: Any]] = []
        while true { let rc = sqlite3_step(s); if rc == SQLITE_DONE { break }; guard rc == SQLITE_ROW else { throw fail("database_operation_failed") }; result.append(row(s)) }
        return result
    }
    func withTransaction<T>(_ f: () throws -> T) throws -> T {
        try exec("BEGIN IMMEDIATE")
        do { let value = try f(); try exec("COMMIT"); return value }
        catch { try? exec("ROLLBACK"); throw error }
    }
    func int(_ v: Any?) -> Int64? {
        guard let number=v as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value=number.doubleValue
        guard value.isFinite, value.rounded(.towardZero)==value, value >= 0, value <= 4_102_444_800_000 else { return nil }
        return number.int64Value
    }
    func text(_ v: Any?) -> String? { v as? String }
    func validSourceID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 &&
          value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
          value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
    func request(_ op: String, _ p: [String: Any]) throws -> [String: Any] {
        switch op {
        case "checkpoint":
            var log: Int32 = 0, frames: Int32 = 0
            guard sqlite3_wal_checkpoint_v2(db, nil, SQLITE_CHECKPOINT_TRUNCATE, &log, &frames) == SQLITE_OK else { throw fail("checkpoint_busy") }
            return ["checkpointed": true]
        case "begin_restore":
            guard !restoring, try scalarInt("SELECT COUNT(*) FROM records") == 0 else { throw fail("restore_requires_empty_database") }
            restoring = true
            return ["restoring": true]
        case "end_restore":
            restoring = false
            return ["restoring": false]
        case "stats":
            var counts: [String: Int] = ["total": 0]
            let scopeFloor=try requestedSceneFloor(p)
            let state: String
            if let raw=p["state"] { guard let value=text(raw), ["all","active"].contains(value) else { throw fail("invalid_request") }; state=value }
            else { state="all" }
            var sql="SELECT kind,COUNT(*) FROM records"
            var filters:[String]=[], binds:[(String?,Int64?)]=[]
            if let scopeFloor { filters.append("visibilityFloor<=?"); binds.append((nil,scopeFloor)) }
            if state == "active" { filters.append("state='active'") }
            if !filters.isEmpty { sql += " WHERE " + filters.joined(separator:" AND ") }
            sql += " GROUP BY kind"
            let s = try statement(sql)
            defer { sqlite3_finalize(s) }
            for (i,value) in binds.enumerated() { if let text=value.0 { bind(s,Int32(i+1),text) } else if let number=value.1 { bind(s,Int32(i+1),number) } }
            while sqlite3_step(s) == SQLITE_ROW { let kind = columnText(s,0); let count = Int(sqlite3_column_int64(s,1)); counts[kind] = count; counts["total", default: 0] += count }
            return ["epoch": try epoch(), "counts": counts]
        case "write":
            guard let expected = int(p["epoch"]), let records = p["records"] as? [[String: Any]], records.count <= 200 else { throw fail("invalid_request") }
            let restoreSequence = (p["restoreSequence"] as? Bool) == true
            guard restoreSequence == restoring else { throw fail("invalid_request") }
            return try withTransaction {
                guard try epoch() == expected else { throw fail("stale_epoch") }
                var stagedSequences = Set<Int64>()
                var stagedIDs = Set<String>()
                for r in records {
                    guard let id=text(r["id"]), let sources=r["sources"] as? [String], sources.count <= 200 else { throw fail("invalid_record") }
                    for source in Set(sources) { guard !source.isEmpty, source.utf8.count <= 256, source != id, try exists(source) else { throw fail("invalid_source") } }
                    if restoreSequence {
                        guard stagedIDs.insert(id).inserted, let sequence = safeSequence(r["ingestionSeq"]), stagedSequences.insert(sequence).inserted,
                              try existingIngestionSeq(id) == nil else { throw fail("invalid_record") }
                    } else if r["ingestionSeq"] != nil { throw fail("invalid_record") }
                }
                let stagedFloors = Dictionary(records.compactMap { r -> (String, Int64)? in
                    guard let id = text(r["id"]) else { return nil }
                    let floor = int(r["visibilityFloor"]) ?? 2
                    return (id, floor)
                }, uniquingKeysWith: { _, latest in latest })
                try validateProspectiveCycles(records)
                for r in records {
                    guard let id=text(r["id"]), !id.isEmpty, id.utf8.count <= 256,
                          let kind=text(r["kind"]), ["message","memory","summary","state","task","persona"].contains(kind),
                          let ts=int(r["ts"]), (0...4_102_444_800_000).contains(ts),
                          let updated=int(r["updatedAt"]), (0...4_102_444_800_000).contains(updated),
                          let state=text(r["state"]), ["active","superseded","archived"].contains(state),
                          let body=text(r["body"]), body.utf8.count <= 2 * 1024 * 1024,
                          let tokens=r["tokens"] as? [String], tokens.count <= 512,
                          let sources=r["sources"] as? [String], sources.count <= 200,
                          let domain=text(r["domain"]) ?? (r["domain"] == nil ? "private" : nil),
                          let domainMin=domainFloor(domain),
                          let floor = r["visibilityFloor"] == nil ? Int64(2) : int(r["visibilityFloor"]),
                          (0...2).contains(floor), floor >= domainMin else { throw fail("invalid_record") }
                    let expiry=int(r["expiresAt"])
                    if let rawExpiry=r["expiresAt"], !(rawExpiry is NSNull), (expiry == nil || !(0...4_102_444_800_000).contains(expiry!)) { throw fail("invalid_record") }
                    for token in tokens { guard !token.isEmpty, token.utf8.count <= 256 else { throw fail("invalid_record") } }
                    for source in Set(sources) {
                        guard source != id else { throw fail("invalid_source") }
                        let sourceFloor: Int64
                        if let staged = stagedFloors[source] { sourceFloor = staged }
                        else {
                            let parent = try statement("SELECT visibilityFloor FROM records WHERE id=?")
                            defer { sqlite3_finalize(parent) }; bind(parent,1,source)
                            guard sqlite3_step(parent) == SQLITE_ROW else { throw fail("invalid_source") }
                            sourceFloor = sqlite3_column_int64(parent,0)
                        }
                        guard floor >= sourceFloor else { throw fail("invalid_source") }
                    }
                    guard try directDependentsMeetFloor(id:id,floor:floor,stagedFloors:stagedFloors) else { throw fail("invalid_source") }
                    let ingestionSeq: Int64
                    if restoreSequence {
                        guard let supplied = safeSequence(r["ingestionSeq"]) else { throw fail("invalid_record") }
                        ingestionSeq = supplied
                    } else {
                        if let existing = try existingIngestionSeq(id) { ingestionSeq = existing }
                        else {
                            let next = try nextIngestionSeq()
                            guard next <= 9_007_199_254_740_991 else { throw fail("sequence_exhausted") }
                            ingestionSeq = next
                        }
                    }
                    let s=try statement("INSERT INTO records(id,kind,ts,updatedAt,state,expiresAt,body,domain,visibilityFloor,ingestionSeq) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,ts=excluded.ts,updatedAt=excluded.updatedAt,state=excluded.state,expiresAt=excluded.expiresAt,body=excluded.body,domain=excluded.domain,visibilityFloor=excluded.visibilityFloor"); defer { sqlite3_finalize(s) }
                    bind(s,1,id); bind(s,2,kind); bind(s,3,ts); bind(s,4,updated); bind(s,5,state)
                    if let expiry { sqlite3_bind_int64(s,6,expiry) } else { sqlite3_bind_null(s,6) }
                    bind(s,7,body); bind(s,8,domain); bind(s,9,floor); bind(s,10,ingestionSeq); guard sqlite3_step(s)==SQLITE_DONE else { throw fail("invalid_record") }
                    if restoreSequence { try advanceIngestionCounter(to: ingestionSeq) }
                    let del=try statement("DELETE FROM tokens WHERE recordId=?"); bind(del,1,id); _=sqlite3_step(del); sqlite3_finalize(del)
                    let unlink=try statement("DELETE FROM links WHERE derivedId=?"); bind(unlink,1,id); _=sqlite3_step(unlink); sqlite3_finalize(unlink)
                    for token in Set(tokens) { let q=try statement("INSERT INTO tokens(recordId,token) VALUES(?,?)"); bind(q,1,id); bind(q,2,token); guard sqlite3_step(q)==SQLITE_DONE else { sqlite3_finalize(q); throw fail("invalid_record") }; sqlite3_finalize(q) }
                    for source in Set(sources) {
                        let q=try statement("INSERT INTO links(sourceId,derivedId) VALUES(?,?)"); bind(q,1,source); bind(q,2,id); guard sqlite3_step(q)==SQLITE_DONE else { sqlite3_finalize(q); throw fail("invalid_source") }; sqlite3_finalize(q)
                    }
                }
                return ["epoch": try epoch(), "written": records.count]
            }
        case "memory_sample":
            guard let partitions=p["partitions"] as? [[String: Any]], partitions.count <= 6,
                  let percent=int(p["percent"]), [5,10].contains(percent), let now=int(p["now"]) else { throw fail("invalid_request") }
            var filters:[String]=[], binds:[(String?,Int64?)]=[]
            for part in partitions {
                guard let domain=text(part["domain"]), let minimum=domainFloor(domain),
                      let floor=int(part["visibilityFloor"]), floor >= minimum, floor <= 2,
                      let cutoff=int(part["cutoff"]) else { throw fail("invalid_request") }
                filters.append("(domain=? AND visibilityFloor=? AND ingestionSeq<=?)")
                binds += [(domain,nil),(nil,floor),(nil,cutoff)]
            }
            guard !filters.isEmpty else { return ["rows": [], "count": 0] }
            var predicate="kind='memory' AND state='active' AND (expiresAt IS NULL OR expiresAt>?) AND (" + filters.joined(separator:" OR ") + ")"
            var allBinds:[(String?,Int64?)]=[(nil,now)] + binds
            if let floor=try requestedSceneFloor(p) { predicate += " AND visibilityFloor<=?"; allBinds.append((nil,floor)) }
            let required=try tokenFilters(p,"requiredTokens"), excluded=try tokenFilters(p,"excludedTokens")
            appendTokenFilters(required,excluded,"records.id",&predicate,&allBinds)
            let countQuery=try statement("SELECT COUNT(*) FROM records WHERE " + predicate)
            defer { sqlite3_finalize(countQuery) }
            for (i,v) in allBinds.enumerated() { if let t=v.0 { bind(countQuery,Int32(i+1),t) } else if let n=v.1 { bind(countQuery,Int32(i+1),n) } }
            guard sqlite3_step(countQuery)==SQLITE_ROW else { throw fail("database_operation_failed") }
            let count=Int(sqlite3_column_int64(countQuery,0)), take=min(50,(count*Int(percent)+99)/100)
            var offsets=Set<Int>()
            while offsets.count < take { offsets.insert(Int.random(in: 0..<count)) }
            var sampled:[[String: Any]]=[]
            for offset in offsets.sorted() {
                sampled += try rows("SELECT id,kind,ts,updatedAt,state,expiresAt,body,domain,visibilityFloor,ingestionSeq FROM records WHERE " + predicate + " ORDER BY ingestionSeq LIMIT 1 OFFSET \(offset)", allBinds)
            }
            return ["rows":sampled,"count":count]
        case "query":
            let rawLimit: Int64
            if let raw = p["limit"] { guard let value=int(raw) else { throw fail("invalid_request") }; rawLimit=value }
            else { rawLimit=50 }
            let limit=min(200,max(1,Int(rawLimit)))
            let state: String
            if let raw = p["state"] { guard let value=text(raw), ["all","active","superseded","archived"].contains(value) else { throw fail("invalid_request") }; state=value }
            else { state="active" }
            let sort: String
            if let raw=p["sort"] { guard let value=text(raw), ["time","ingestion"].contains(value) else { throw fail("invalid_request") }; sort=value } else { sort="time" }
            let beforeSeq: Int64?
            if let raw=p["beforeSeq"] { guard let value=int(raw), sort == "ingestion" else { throw fail("invalid_request") }; beforeSeq=value } else { beforeSeq=nil }
            let afterSeq: Int64?
            if let raw=p["afterSeq"] { guard let value=int(raw), sort == "ingestion" else { throw fail("invalid_request") }; afterSeq=value } else { afterSeq=nil }
            if sort == "ingestion" && (p["before"] != nil || p["beforeId"] != nil || p["after"] != nil || p["afterId"] != nil) { throw fail("invalid_request") }
            if sort != "ingestion" && (p["beforeSeq"] != nil || p["afterSeq"] != nil) { throw fail("invalid_request") }
            let sourceID: String?
            if let raw=p["sourceId"] {
                guard let value=text(raw), validSourceID(value) else { throw fail("invalid_request") }
                sourceID=value
            } else { sourceID=nil }
            var sql="SELECT records.id,records.kind,records.ts,records.updatedAt,records.state,records.expiresAt,records.body,records.domain,records.visibilityFloor,records.ingestionSeq FROM "
            var binds:[(String?,Int64?)]=[]
            if let sourceID {
                // CROSS JOIN fixes links as the selective origin. The planner
                // otherwise walks all ordered records before checking EXISTS.
                sql += "links CROSS JOIN records ON records.id=links.derivedId WHERE links.sourceId=?"
                binds.append((sourceID,nil))
            } else { sql += "records WHERE 1=1" }
            if let floor=try requestedSceneFloor(p) { sql += " AND visibilityFloor<=?"; binds.append((nil,floor)) }
            if let raw=p["domain"] { guard let domain=text(raw), domainFloor(domain) != nil else { throw fail("invalid_request") }; sql += " AND domain=?"; binds.append((domain,nil)) }
            if let raw=p["visibilityFloor"] { guard let floor=int(raw), (0...2).contains(floor) else { throw fail("invalid_request") }; sql += " AND visibilityFloor=?"; binds.append((nil,floor)) }
            let before: Int64?
            if let raw=p["before"] { guard let value=int(raw) else { throw fail("invalid_request") }; before=value } else { before=nil }
            let after: Int64?
            if let raw=p["after"] { guard let value=int(raw) else { throw fail("invalid_request") }; after=value } else { after=nil }
            let beforeId: String?
            if let raw=p["beforeId"] { guard let value=text(raw), !value.isEmpty, value.utf8.count<=256, before != nil else { throw fail("invalid_request") }; beforeId=value } else { beforeId=nil }
            let afterId: String?
            if let raw=p["afterId"] { guard let value=text(raw), !value.isEmpty, value.utf8.count<=256, after != nil else { throw fail("invalid_request") }; afterId=value } else { afterId=nil }
            let order: String
            if let raw=p["order"] { guard let value=text(raw), ["asc","desc"].contains(value) else { throw fail("invalid_request") }; order=value } else { order="desc" }
            if state != "all" { sql += " AND state=?"; binds.append((state,nil)) }
            if let raw=p["kind"] { guard let kind=text(raw) else { throw fail("invalid_request") }; sql += " AND kind=?"; binds.append((kind,nil)) }
            if let before {
                if let beforeId { sql += " AND (ts<? OR (ts=? AND id<?))"; binds += [(nil,before),(nil,before),(beforeId,nil)] }
                else { sql += " AND ts<?"; binds.append((nil,before)) }
            }
            if let after {
                if let afterId { sql += " AND (ts>? OR (ts=? AND id>?))"; binds += [(nil,after),(nil,after),(afterId,nil)] }
                else { sql += " AND ts>?"; binds.append((nil,after)) }
            }
            if let beforeSeq { sql += " AND ingestionSeq<?"; binds.append((nil,beforeSeq)) }
            if let afterSeq { sql += " AND ingestionSeq>?"; binds.append((nil,afterSeq)) }
            let requiredTokens = try tokenFilters(p, "requiredTokens")
            let excludedTokens = try tokenFilters(p, "excludedTokens")
            appendTokenFilters(requiredTokens, excludedTokens, "records.id", &sql, &binds)
            if sort == "ingestion" { sql += order == "asc" ? " ORDER BY ingestionSeq ASC LIMIT \(limit)" : " ORDER BY ingestionSeq DESC LIMIT \(limit)" }
            else { sql += order == "asc" ? " ORDER BY ts ASC,id ASC LIMIT \(limit)" : " ORDER BY ts DESC,id DESC LIMIT \(limit)" }
            return ["rows": try rows(sql,binds)]
        case "get":
            guard let ids=p["ids"] as? [String], ids.count <= 200 else { throw fail("invalid_request") }
            if ids.isEmpty { return ["rows": []] }
            let placeholders=Array(repeating:"?",count:ids.count).joined(separator:",")
            var sql="SELECT id,kind,ts,updatedAt,state,expiresAt,body,domain,visibilityFloor,ingestionSeq FROM records WHERE id IN (\(placeholders))"; var binds=ids.map{($0,nil) as (String?,Int64?)}
            if let floor=try requestedSceneFloor(p) { sql += " AND visibilityFloor<=?"; binds.append((nil,floor)) }
            sql += " ORDER BY ts DESC,id DESC"
            return ["rows": try rows(sql,binds)]
        case "search":
            guard let tokens=p["tokens"] as? [String], tokens.count <= 128, let now=int(p["now"]) else { throw fail("invalid_request") }
            let requiredTokens = try tokenFilters(p, "requiredTokens")
            let excludedTokens = try tokenFilters(p, "excludedTokens")
            let anyTokens = p["anyTokens"] as? [String] ?? []
            guard anyTokens.count <= 512, anyTokens.allSatisfy(validHMACToken), p["anyTokens"] == nil || p["anyTokens"] is [String] else { throw fail("invalid_request") }
            if tokens.isEmpty { return ["rows": []] }
            let kinds = (p["kinds"] as? [String]) ?? (text(p["kind"]).map{[$0]} ?? [])
            let limit=min(50,max(1,Int(int(p["limit"]) ?? 20)))
            let uniqueTokens=Array(Set(tokens)); let marks=Array(repeating:"?",count:uniqueTokens.count).joined(separator:",")
            let origin: String
            if anyTokens.isEmpty { origin = "records r JOIN tokens t ON t.recordId=r.id" }
            else {
                let anyMarks = Array(repeating: "?", count: anyTokens.count).joined(separator: ",")
                origin = "(SELECT DISTINCT recordId FROM tokens WHERE token IN (\(anyMarks))) candidates CROSS JOIN records r ON r.id=candidates.recordId CROSS JOIN tokens t ON t.recordId=r.id"
            }
            var sql="SELECT r.id,r.kind,r.ts,r.updatedAt,r.state,r.expiresAt,r.body,r.domain,r.visibilityFloor,r.ingestionSeq,COUNT(*) score FROM \(origin) WHERE r.state='active' AND (r.expiresAt IS NULL OR r.expiresAt>?) AND t.token IN (\(marks))"
            var vals:[(String?,Int64?)]=anyTokens.map{($0,nil)}+[(nil,now)]+uniqueTokens.map{($0,nil)}
            if let floor=try requestedSceneFloor(p) { sql += " AND r.visibilityFloor<=?"; vals.append((nil,floor)) }
            if let raw=p["domain"] {
                guard let domain=text(raw), domainFloor(domain) != nil else { throw fail("invalid_request") }
                sql += " AND r.domain=?"; vals.append((domain,nil))
            }
            if let raw=p["visibilityFloor"] {
                guard let floor=int(raw), (0...2).contains(floor) else { throw fail("invalid_request") }
                sql += " AND r.visibilityFloor=?"; vals.append((nil,floor))
            }
            if !kinds.isEmpty { sql += " AND r.kind IN (\(Array(repeating:"?",count:kinds.count).joined(separator:",")))"; vals += kinds.map{($0,nil)} }
            appendTokenFilters(requiredTokens, excludedTokens, "r.id", &sql, &vals)
            sql += " GROUP BY r.id ORDER BY score DESC,r.ts DESC,r.id DESC LIMIT \(limit)"
            let s=try statement(sql); defer{sqlite3_finalize(s)}
            for (i,v) in vals.enumerated(){ if let t=v.0 {bind(s,Int32(i+1),t)} else if let n=v.1 {bind(s,Int32(i+1),n)} }
            var out:[[String:Any]]=[]
            while true {let rc=sqlite3_step(s);if rc==SQLITE_DONE{break};guard rc==SQLITE_ROW else{throw fail("database_operation_failed")};var x=row(s);x["score"]=sqlite3_column_int64(s,10);out.append(x)}
            return ["rows":out]
        case "remove":
            guard let expected=int(p["epoch"]), let id=text(p["recordId"]) else { throw fail("invalid_request") }
            let result = try withTransaction { () -> [String:Any] in
                guard try epoch()==expected else {throw fail("stale_epoch")}
                // Metadata only: surviving raw inputs of removed derivatives
                // identify the earliest Dream work that must be revisited.
                let rewindQuery=try statement("""
                    WITH RECURSIVE gone(id) AS (
                      SELECT id FROM records WHERE id=?
                      UNION SELECT links.derivedId FROM links JOIN gone ON links.sourceId=gone.id
                    ), affected AS (
                      SELECT r.domain,r.visibilityFloor,r.ingestionSeq FROM records r JOIN gone ON gone.id=r.id WHERE r.kind='message'
                      UNION ALL
                      SELECT r.domain,r.visibilityFloor,r.ingestionSeq FROM gone JOIN links ON links.derivedId=gone.id
                        JOIN records r ON r.id=links.sourceId WHERE r.kind='message'
                    ) SELECT domain,visibilityFloor,MIN(ingestionSeq) FROM affected GROUP BY domain,visibilityFloor
                    """)
                bind(rewindQuery,1,id)
                var rewind:[[String:Any]]=[]
                while true {
                    let rc=sqlite3_step(rewindQuery)
                    if rc==SQLITE_DONE { break }
                    guard rc==SQLITE_ROW else { sqlite3_finalize(rewindQuery); throw fail("database_operation_failed") }
                    rewind.append(["domain":columnText(rewindQuery,0),"visibilityFloor":sqlite3_column_int64(rewindQuery,1),"ingestionSeq":sqlite3_column_int64(rewindQuery,2)])
                }
                sqlite3_finalize(rewindQuery)
                let q=try statement("WITH RECURSIVE gone(id) AS (SELECT id FROM records WHERE id=? UNION SELECT links.derivedId FROM links JOIN gone ON links.sourceId=gone.id) SELECT id FROM gone");bind(q,1,id)
                var gone:[String]=[];while sqlite3_step(q)==SQLITE_ROW{gone.append(columnText(q,0))};sqlite3_finalize(q)
                for target in gone {let d=try statement("DELETE FROM records WHERE id=?");bind(d,1,target);_=sqlite3_step(d);sqlite3_finalize(d)}
                return ["epoch":try advanceEpoch(),"removed":gone.count,"rewind":rewind]
            }
            try exec("PRAGMA wal_checkpoint(TRUNCATE)"); return result
        case "clear":
            restoring = false
            let result=try withTransaction { () -> [String:Any] in try exec("DELETE FROM records"); return ["epoch":try advanceEpoch()] }
            try exec("PRAGMA wal_checkpoint(TRUNCATE)"); return result
        default: throw fail("unknown_operation")
        }
    }
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let store: DB
do { store = try DB(path: CommandLine.arguments[1]) }
catch let e as VaultError { send(["type":"fatal", "error":e.code]); exit(3) }
catch { send(["type":"fatal", "error":"database_open_failed"]); exit(3) }
var input = Data()

// Drain Foundation autoreleased JSON/bridge objects after each complete
// request. Keep the response write inside the pool so request-sized result
// dictionaries and encoded Data do not accumulate in the long-lived process.
func processRequestLine(_ line: Data, store: DB) {
    autoreleasepool {
        var responseID: Any = NSNull()
        do {
            guard let obj=try JSONSerialization.jsonObject(with:line) as? [String:Any], let id=obj["id"], let op=obj["op"] as? String else { throw fail("invalid_request") }
            responseID=id
            let result=try store.request(op,obj)
            var response:[String:Any]=["id":id,"ok":true]; for (k,v) in result { response[k]=v }
            send(response)
        } catch let e as VaultError { send(["id":responseID,"ok":false,"error":e.code]) }
        catch { send(["id":responseID,"ok":false,"error":"invalid_request"]) }
    }
}

while true {
    let chunk = autoreleasepool { FileHandle.standardInput.availableData }
    if chunk.isEmpty { break }
    input.append(chunk)
    if input.count > maxLineBytes && input.firstIndex(of: 10) == nil { send(["id": NSNull(), "ok": false, "error":"request_too_large"]); exit(4) }
    while let nl=input.firstIndex(of:10) {
        let line=Data(input[..<nl]);input.removeSubrange(...nl)
        guard line.count <= maxLineBytes else {send(["id":NSNull(),"ok":false,"error":"request_too_large"]);continue}
        processRequestLine(line, store: store)
    }
}
