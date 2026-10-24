# Workbunny memory scale check

This run used the real `MemoryService` and compiled SQLite helper with a private temporary database. It generated 10,000 synthetic messages and 2,000 synthetic memories over a ten-year timestamp range. Each memory references an existing synthetic message. The four pinned test facts span four UTC calendar years.

The safeStorage substitute used an in-memory test key. The benchmark made no WorkBuddy or model requests and did not read or write the user's vault or Keychain. All generated text is public-style fixture text, not personal data.

`databaseBuild` measures service initialization and row writes; it excludes Swift compilation. Retrieval reports 30 alternating Chinese and English searches. Context reports 10 builds with an 8,500 character cap. Reopen measures initialization after closing the first service. The database and WAL sizes were sampled while the database was open.

The current run built the 12,000-row database in 4.24 s. Retrieval p50/p95 was 6.89/8.92 ms; context p50/p95 was 52.53/64.22 ms and used at most 1,670 characters; reopen took 10.83 ms. The database plus WAL measured 44,438,480 bytes. Chinese and English old-fact searches passed, all four pinned facts spanning four UTC years appeared in context, and reopen returned 10,000 messages plus 2,000 memories.

Results are in [workbunny-memory-benchmark-2026-10-25.json](workbunny-memory-benchmark-2026-10-25.json). This is a synthetic scale and reopen simulation, not evidence of ten-year production reliability, real user-memory quality, crash recovery under power loss, or real application behavior. Use `node tools/benchmark-memory.js --rows=200` for a quick run; the default is 10,000 messages and 2,000 memories.
