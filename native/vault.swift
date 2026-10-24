import Foundation
import SQLite3
import CoreFoundation
import Darwin

let maxLineBytes = 16 * 1024 * 1024
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

final class DB {
    var db: OpaquePointer?
    init(path: String) throws {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let dir = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        let rc = sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard rc == SQLITE_OK, let db else { throw fail("database_open_failed") }
        _ = sqlite3_busy_timeout(db, 5000)
        try exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;")
        let chmodRC = url.path.withCString { chmod($0, 0o600) }
        guard chmodRC == 0 else { throw fail("database_permissions_failed") }
        let version = try scalarInt("PRAGMA user_version")
        guard version <= 1 else { throw fail("database_version_newer") }
        if version == 0 {
            try exec("""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS records(
                  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ts INTEGER NOT NULL,
                  updatedAt INTEGER NOT NULL, state TEXT NOT NULL,
                  expiresAt INTEGER, body TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS records_kind_state_ts_id_idx ON records(kind,state,ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_state_ts_id_idx ON records(state,ts DESC,id DESC);
                CREATE INDEX IF NOT EXISTS records_ts_id_idx ON records(ts DESC,id DESC);
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
                PRAGMA user_version=1;
                COMMIT;
                """)
        } else {
            try exec("CREATE INDEX IF NOT EXISTS records_kind_state_ts_id_idx ON records(kind,state,ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_state_ts_id_idx ON records(state,ts DESC,id DESC); CREATE INDEX IF NOT EXISTS records_ts_id_idx ON records(ts DESC,id DESC); CREATE INDEX IF NOT EXISTS tokens_token_idx ON tokens(token); CREATE INDEX IF NOT EXISTS links_derived_idx ON links(derivedId);")
        }
    }
    deinit { if let db { sqlite3_close_v2(db) } }
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
    func advanceEpoch() throws -> Int64 { try exec("UPDATE meta SET value=value+1 WHERE key='epoch'"); return try epoch() }
    func exists(_ id: String) throws -> Bool {
        let s=try statement("SELECT 1 FROM records WHERE id=? LIMIT 1"); defer{sqlite3_finalize(s)}
        bind(s,1,id); return sqlite3_step(s)==SQLITE_ROW
    }
    func createsCycle(source: String, derived: String) throws -> Bool {
        let s=try statement("WITH RECURSIVE reachable(id) AS (SELECT ? UNION SELECT links.derivedId FROM links JOIN reachable ON links.sourceId=reachable.id) SELECT 1 FROM reachable WHERE id=? LIMIT 1")
        defer{sqlite3_finalize(s)}; bind(s,1,derived); bind(s,2,source); return sqlite3_step(s)==SQLITE_ROW
    }
    func row(_ s: OpaquePointer) -> [String: Any] {
        var out: [String: Any] = ["id": columnText(s,0), "kind": columnText(s,1), "ts": sqlite3_column_int64(s,2), "updatedAt": sqlite3_column_int64(s,3), "state": columnText(s,4), "body": columnText(s,6)]
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
    func request(_ op: String, _ p: [String: Any]) throws -> [String: Any] {
        switch op {
        case "stats":
            var counts: [String: Int] = ["total": 0]
            let s = try statement("SELECT kind,COUNT(*) FROM records GROUP BY kind"); defer { sqlite3_finalize(s) }
            while sqlite3_step(s) == SQLITE_ROW { let kind = columnText(s,0); let count = Int(sqlite3_column_int64(s,1)); counts[kind] = count; counts["total", default: 0] += count }
            return ["epoch": try epoch(), "counts": counts]
        case "write":
            guard let expected = int(p["epoch"]), let records = p["records"] as? [[String: Any]], records.count <= 200 else { throw fail("invalid_request") }
            return try withTransaction {
                guard try epoch() == expected else { throw fail("stale_epoch") }
                for r in records {
                    guard let id=text(r["id"]), let sources=r["sources"] as? [String], sources.count <= 200 else { throw fail("invalid_record") }
                    for source in Set(sources) { guard !source.isEmpty, source.utf8.count <= 256, source != id, try exists(source) else { throw fail("invalid_source") } }
                }
                for r in records {
                    guard let id=text(r["id"]), !id.isEmpty, id.utf8.count <= 256,
                          let kind=text(r["kind"]), ["message","memory","summary","state","task","persona"].contains(kind),
                          let ts=int(r["ts"]), (0...4_102_444_800_000).contains(ts),
                          let updated=int(r["updatedAt"]), (0...4_102_444_800_000).contains(updated),
                          let state=text(r["state"]), ["active","superseded"].contains(state),
                          let body=text(r["body"]), body.utf8.count <= 2 * 1024 * 1024,
                          let tokens=r["tokens"] as? [String], tokens.count <= 512,
                          let sources=r["sources"] as? [String], sources.count <= 200 else { throw fail("invalid_record") }
                    let expiry=int(r["expiresAt"])
                    if let rawExpiry=r["expiresAt"], !(rawExpiry is NSNull), (expiry == nil || !(0...4_102_444_800_000).contains(expiry!)) { throw fail("invalid_record") }
                    for token in tokens { guard !token.isEmpty, token.utf8.count <= 256 else { throw fail("invalid_record") } }
                    for source in Set(sources) {
                        guard source != id else { throw fail("invalid_source") }
                    }
                    let s=try statement("INSERT INTO records(id,kind,ts,updatedAt,state,expiresAt,body) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,ts=excluded.ts,updatedAt=excluded.updatedAt,state=excluded.state,expiresAt=excluded.expiresAt,body=excluded.body"); defer { sqlite3_finalize(s) }
                    bind(s,1,id); bind(s,2,kind); bind(s,3,ts); bind(s,4,updated); bind(s,5,state)
                    if let expiry { sqlite3_bind_int64(s,6,expiry) } else { sqlite3_bind_null(s,6) }
                    bind(s,7,body); guard sqlite3_step(s)==SQLITE_DONE else { throw fail("invalid_record") }
                    let del=try statement("DELETE FROM tokens WHERE recordId=?"); bind(del,1,id); _=sqlite3_step(del); sqlite3_finalize(del)
                    let unlink=try statement("DELETE FROM links WHERE derivedId=?"); bind(unlink,1,id); _=sqlite3_step(unlink); sqlite3_finalize(unlink)
                    for token in Set(tokens) { let q=try statement("INSERT INTO tokens(recordId,token) VALUES(?,?)"); bind(q,1,id); bind(q,2,token); guard sqlite3_step(q)==SQLITE_DONE else { sqlite3_finalize(q); throw fail("invalid_record") }; sqlite3_finalize(q) }
                    for source in Set(sources) {
                        guard try !createsCycle(source:source,derived:id) else { throw fail("invalid_source") }
                        let q=try statement("INSERT INTO links(sourceId,derivedId) VALUES(?,?)"); bind(q,1,source); bind(q,2,id); guard sqlite3_step(q)==SQLITE_DONE else { sqlite3_finalize(q); throw fail("invalid_source") }; sqlite3_finalize(q)
                    }
                }
                return ["epoch": try epoch(), "written": records.count]
            }
        case "query":
            let limit=min(200,max(1,Int(int(p["limit"]) ?? 50))), state=text(p["state"]) ?? "active"
            var sql="SELECT id,kind,ts,updatedAt,state,expiresAt,body FROM records WHERE 1=1"; var binds:[(String?,Int64?)]=[]
            if state != "all" { sql += " AND state=?"; binds.append((state,nil)) }
            if let kind=text(p["kind"]) { sql += " AND kind=?"; binds.append((kind,nil)) }
            if let before=int(p["before"]) {
                if let beforeId=text(p["beforeId"]) { sql += " AND (ts<? OR (ts=? AND id<?))"; binds += [(nil,before),(nil,before),(beforeId,nil)] }
                else { sql += " AND ts<?"; binds.append((nil,before)) }
            }
            if let after=int(p["after"]) { sql += " AND ts>?"; binds.append((nil,after)) }
            sql += " ORDER BY ts DESC,id DESC LIMIT \(limit)"
            return ["rows": try rows(sql,binds)]
        case "get":
            guard let ids=p["ids"] as? [String], ids.count <= 200 else { throw fail("invalid_request") }
            if ids.isEmpty { return ["rows": []] }
            let placeholders=Array(repeating:"?",count:ids.count).joined(separator:",")
            return ["rows": try rows("SELECT id,kind,ts,updatedAt,state,expiresAt,body FROM records WHERE id IN (\(placeholders)) ORDER BY ts DESC,id DESC",ids.map{($0,nil)})]
        case "search":
            guard let tokens=p["tokens"] as? [String], tokens.count <= 128, let now=int(p["now"]) else { throw fail("invalid_request") }
            if tokens.isEmpty { return ["rows": []] }
            let kinds = (p["kinds"] as? [String]) ?? (text(p["kind"]).map{[$0]} ?? [])
            let limit=min(50,max(1,Int(int(p["limit"]) ?? 20)))
            let uniqueTokens=Array(Set(tokens)); let marks=Array(repeating:"?",count:uniqueTokens.count).joined(separator:",")
            var sql="SELECT r.id,r.kind,r.ts,r.updatedAt,r.state,r.expiresAt,r.body,COUNT(*) score FROM records r JOIN tokens t ON t.recordId=r.id WHERE r.state='active' AND (r.expiresAt IS NULL OR r.expiresAt>?) AND t.token IN (\(marks))"
            var vals:[(String?,Int64?)]=[(nil,now)]+uniqueTokens.map{($0,nil)}
            if !kinds.isEmpty { sql += " AND r.kind IN (\(Array(repeating:"?",count:kinds.count).joined(separator:",")))"; vals += kinds.map{($0,nil)} }
            sql += " GROUP BY r.id ORDER BY score DESC,r.ts DESC,r.id DESC LIMIT \(limit)"
            let s=try statement(sql); defer{sqlite3_finalize(s)}
            for (i,v) in vals.enumerated(){ if let t=v.0 {bind(s,Int32(i+1),t)} else if let n=v.1 {bind(s,Int32(i+1),n)} }
            var out:[[String:Any]]=[]
            while true {let rc=sqlite3_step(s);if rc==SQLITE_DONE{break};guard rc==SQLITE_ROW else{throw fail("database_operation_failed")};var x=row(s);x["score"]=sqlite3_column_int64(s,7);out.append(x)}
            return ["rows":out]
        case "remove":
            guard let expected=int(p["epoch"]), let id=text(p["recordId"]) else { throw fail("invalid_request") }
            let result = try withTransaction { () -> [String:Any] in
                guard try epoch()==expected else {throw fail("stale_epoch")}
                let q=try statement("WITH RECURSIVE gone(id) AS (SELECT id FROM records WHERE id=? UNION SELECT links.derivedId FROM links JOIN gone ON links.sourceId=gone.id) SELECT id FROM gone");bind(q,1,id)
                var gone:[String]=[];while sqlite3_step(q)==SQLITE_ROW{gone.append(columnText(q,0))};sqlite3_finalize(q)
                for target in gone {let d=try statement("DELETE FROM records WHERE id=?");bind(d,1,target);_=sqlite3_step(d);sqlite3_finalize(d)}
                return ["epoch":try advanceEpoch(),"removed":gone.count]
            }
            try exec("PRAGMA wal_checkpoint(TRUNCATE)"); return result
        case "clear":
            let result=try withTransaction { () -> [String:Any] in try exec("DELETE FROM records"); return ["epoch":try advanceEpoch()] }
            try exec("PRAGMA wal_checkpoint(TRUNCATE)"); return result
        default: throw fail("unknown_operation")
        }
    }
}

guard CommandLine.arguments.count == 2 else { exit(2) }
let store: DB
do { store = try DB(path: CommandLine.arguments[1]) } catch { exit(3) }
var input = Data()
while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { break }
    input.append(chunk)
    if input.count > maxLineBytes && input.firstIndex(of: 10) == nil { send(["id": NSNull(), "ok": false, "error":"request_too_large"]); exit(4) }
    while let nl=input.firstIndex(of:10) {
        let line=Data(input[..<nl]);input.removeSubrange(...nl)
        guard line.count <= maxLineBytes else {send(["id":NSNull(),"ok":false,"error":"request_too_large"]);continue}
        var responseID: Any = NSNull()
        do {
            guard let obj=try JSONSerialization.jsonObject(with:line) as? [String:Any], let id=obj["id"], let op=obj["op"] as? String else {throw fail("invalid_request")}
            responseID=id
            let payload=obj
            let result=try store.request(op,payload)
            var response:[String:Any]=["id":id,"ok":true];for (k,v) in result {response[k]=v};send(response)
        } catch let e as VaultError { send(["id":responseID,"ok":false,"error":e.code]) }
        catch { send(["id":responseID,"ok":false,"error":"invalid_request"]) }
    }
}
