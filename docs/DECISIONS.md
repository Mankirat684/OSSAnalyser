# Architectural Decisions Log (docs/DECISIONS.md)

This document records key technical decisions, deviations, and rationale per Section 0 (Ground Rules) of the OSS Analyser CLI + MCP Server Implementation Spec.

---

## 1. Storage Backend: `better-sqlite3` with Native C Addons

- **Decision:** Migrated from `node:sqlite` (Node experimental built-in) to `better-sqlite3` with `sqlite-vec`.
- **Rationale:** While `node:sqlite` avoids npm dependencies, it cannot load native C extension binaries like `sqlite-vec` cleanly on Windows platforms. `better-sqlite3` supports native extension loading via `sqliteVec.load(db)` and provides robust synchronous transaction boundaries (`db.transaction()`), WAL mode, and FTS5.
- **Outcome:** Persistent vector storage (`vec0` virtual table) and sub-millisecond local execution.

---

## 2. Vector Extension: `sqlite-vec` + Fallback Degradation

- **Decision:** Load `sqlite-vec` dynamically into `better-sqlite3`. If extension loading fails on any unsupported platform or architecture, gracefully degrade to the in-memory feature-hash `VectorEngine` without crashing.
- **Rationale:** Ground Rule 0 and Section 2.1 dictate that `doctor` reports vector engine status and retrieval falls back cleanly to lexical-only or in-memory semantic projection.
- **Outcome:** Zero platform-specific build failures while providing native SIMD KNN acceleration where available.

---

## 3. Extractor Strategy: Dual Native AST & Graphify Adapter

- **Decision:** Implement both `NativeExtractor` (zero-dependency regex/TypeScript compiler parser) and `GraphifyExtractor` (Tree-sitter-based multilingual engine via `graphifyy` CLI).
- **Rationale:** Native AST provides out-of-the-box zero-setup extraction for TypeScript, JavaScript, and Python without requiring external Python environments. Graphify provides deep multilingual AST extraction (Go, Rust, C++, Java, etc.) and pre-extracted call graph resolution.
- **Outcome:** Users can toggle via `--extractor native|graphify` (default: `native`).

---

## 4. MCP Stdio Server Configuration for Coding Harnesses

- **Decision:** Configure `.mcp.json` to execute `npx tsx src/cli/index.ts serve` rather than an unpublished global `oss-analyser` package binary.
- **Rationale:** Coding harnesses (Claude Code, Cursor) running locally need immediate execution without requiring `npm publish` or manual `npm link`.
- **Outcome:** One-click integration with harnesses directly from repo clone.

---

## 5. Schema Parity Preservation

- **Decision:** Enforce 100% column name and type compatibility between SQLite `knowledge.db` and the Postgres web-app schema for core tables (`repositories`, `code_nodes`, `code_edges`, `git_ownership`).
- **Rationale:** Facilitates bi-directional sync, unified UI models, and direct reuse of recursive CTE graph traversal queries.
- **Outcome:** Verified by `tests/sqlite_parity.test.ts`.

---

## 6. Token Budgeting & Secret Redaction

- **Decision:** Hard server-side token budget enforcement (`envelope.ts`) with priority packing, and pre-prompt regex secret scanning (`secretScanner.ts`) targeting AWS keys, JWT tokens, and private API credentials.
- **Rationale:** Prevent harness context window blowout and eliminate token data leakage to remote LLM providers.
- **Outcome:** Verified by `tests/mcp_server.test.ts` and `tests/summarizer_phase3.test.ts`.

---

## 7. Automated Schema Migration Engine via `PRAGMA user_version`

- **Decision:** Use SQLite's native `PRAGMA user_version` together with version-numbered SQL files (`src/storage/sqlite/migrations/001_initial.sql`, etc.) rather than an external ORM migration framework.
- **Rationale:** Keeps the CLI and MCP runtime zero-overhead and synchronous. `SQLiteStore.init()` automatically detects and applies pending migrations within isolated database transactions.
- **Outcome:** Automated schema evolution without breaking local workspaces across version upgrades. Verified by `tests/sqlite_migrations.test.ts`.

---

## 8. Bi-directional Knowledge Graph Sync (PostgreSQL & JSON Dump)

- **Decision:** Introduce `oss-analyser export` (alias `oss-analyser sync`) supporting direct PostgreSQL bulk-sync (`--postgres` / `--url`) and portable JSON archive serialization (`--dump` / `--import-dump`).
- **Rationale:** Bridges the local-first CLI context layer with the existing PostgreSQL-backed web dashboard and visualization UI, allowing repositories indexed locally to be viewed on `localhost:4000` or shared across team members without re-indexing.
- **Outcome:** Zero-loss round-trip serialization of repositories, nodes, edges, and git blame ownership. Verified by `tests/sync_export.test.ts`.

---

## 9. Deterministic Item-Count Pagination over Heuristic Token Truncation

- **Decision:** Replaced heuristic token-slicing with explicit item-count pagination (`total`, `returned`, `next_cursor`, and `limit: "all"`).
- **Rationale:** Unbounded responses risk silent truncation by harness host environments (Claude Code, Cursor) without the agent knowing what was lost. Token-slicing dropped items without informing the agent. Explicit pagination guarantees the agent always knows whether it has the complete dataset (`returned === total`) or a partial page (`next_cursor !== null`), and allows the agent to request everything in one shot via `limit: "all"`.
- **Outcome:** Applied across `search_symbols`, `get_dependencies`, `get_callers`, `get_blast_radius`, `get_module_summary`, and `get_file_contract`. Verified by `tests/mcp_server.test.ts`.
