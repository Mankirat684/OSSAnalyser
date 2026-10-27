# OSS Analyser 🧭

> **Local-first Codebase Knowledge Graph & Model Context Protocol (MCP) Server for AI Coding Harnesses.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-FTS5%20%7C%20Recursive%20CTE-blue.svg)](https://www.sqlite.org/)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-orange.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

OSS Analyser is a high-performance, local-first code intelligence engine designed specifically for **AI coding agents** (Google Antigravity, Claude Code, Cursor, Windsurf). Instead of forcing agents to brute-force read whole source files or flood context windows with noisy grep outputs, OSS Analyser indexes codebases into an offline AST call graph stored in SQLite, condenses cyclic dependencies using **Tarjan's Strongly Connected Components (SCC)**, and serves structured dependency traversal tools via the **Model Context Protocol (MCP)**.

In empirical benchmarks on real open-source libraries ([pmndrs/zustand](https://github.com/pmndrs/zustand), [encode/starlette](https://github.com/encode/starlette)), OSS Analyser delivers a **58% median context reduction** against keyword-matched windowed grep baselines, and up to **95% token savings** on multi-file blast-radius analysis.

---

## ⚡ Key Highlights

- **Local-First & Zero Latency**: Runs entirely on developer machines using an embedded SQLite database (`.oss-analyser/knowledge.db`). No source code leaves the machine.
- **Model Context Protocol (MCP)**: Native stdio MCP server compatible with any MCP client (Claude Desktop, Claude Code, Cursor, Antigravity).
- **Deterministic Item-Count Pagination**: Every list endpoint (`search_symbols`, `get_callers`, `get_blast_radius`, `get_dependencies`, `get_module_summary`) returns `{ total, returned, next_cursor, items }` with `limit: "all"` support. No silent truncation or dropped items.
- **Transitive Blast Radius via Recursive CTEs**: Computes upstream impact across $N$-depth dependencies using SQLite recursive Common Table Expressions with cycle detection.
- **Cycle Condensation via Tarjan's SCC**: Condenses mutual recursion cycles into Directed Acyclic Graphs (DAGs) to enable deterministic bottom-up caching and cache invalidation.
- **Two Indexing Profiles**:
  - **Zero-Token AST Mode (`--extractor graphify`)**: Pure Tree-sitter extraction with 0 LLM indexing tokens spent. Net positive token savings from Query 1.
  - **Hierarchical LLM Mode (`--provider gemini`)**: Bottom-up prose contracts (Function $\rightarrow$ File $\rightarrow$ Module $\rightarrow$ Repo) with pre-flight cost estimation.
- **Optional Self-Hosted Team Sync**: Single-command sync (`oss-analyser sync`) exports local SQLite graphs to a central PostgreSQL database to power team dashboards and shared architectural knowledge.

---

## 🏗 Architecture Overview

```
                      DEVELOPER MACHINE (Local-First)
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   Source Code Files (TS / JS / Python / Go / Rust)                    │
│                        │                                               │
│                        ▼                                               │
│   ┌────────────────────────────────────────┐                          │
│   │   AST Extractor Engine                 │                          │
│   │   • Native AST regex parser            │                          │
│   │   • Graphify Tree-sitter engine        │                          │
│   └────────────────────┬───────────────────┘                          │
│                        │                                               │
│                        ▼                                               │
│   ┌────────────────────────────────────────┐                          │
│   │   Tarjan SCC & Graph Resolver          │                          │
│   │   • Condenses cyclic dependencies      │                          │
│   │   • Bottom-up Topological levels       │                          │
│   │   • Cross-module candidate resolution  │                          │
│   └────────────────────┬───────────────────┘                          │
│                        │                                               │
│                        ▼                                               │
│   ┌────────────────────────────────────────┐                          │
│   │   Local SQLite Knowledge Base          │                          │
│   │   • SQLite FTS5 (BM25 lexical search)  │                          │
│   │   • Recursive CTEs (Blast Radius)      │                          │
│   │   • SHA-256 cascade cache invalidation │                          │
│   └────────────────────┬───────────────────┘                          │
│                        │                                               │
│                        ▼                                               │
│   ┌────────────────────────────────────────┐                          │
│   │   MCP Server (stdio)                   │                          │
│   │   • 10 paginated traversal tools       │                          │
│   │   • Compact JSON envelopes (<350 tok)  │                          │
│   └────────────────────▲───────────────────┘                          │
│                        │ stdio                                         │
└────────────────────────┼───────────────────────────────────────────────┘
                         │
             AI CODING HARNESSES (Local IDE)
   ┌─────────────────────┴─────────────────────┐
   │ • Google Antigravity                      │
   │ • Claude Code / Claude Desktop            │
   │ • Cursor IDE                              │
   │ • Windsurf / Cline                        │
   └───────────────────────────────────────────┘
                         │
                         │ Optional Team Sync (`oss-analyser sync`)
                         ▼
     CENTRALIZED TEAM COLLABORATION (Self-Hosted Option)
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   ┌────────────────────────┐         ┌─────────────────────────────┐   │
│   │  PostgreSQL (pgvector) │ ◄────── │  oss-analyser API Backend   │   │
│   │  • Shared team graphs  │         │  • Express REST API         │   │
│   │  • Drizzle ORM         │         │  • Ingest & harness routes  │   │
│   └────────────────────────┘         └──────────────┬──────────────┘   │
│                                                     │                  │
│                                                     ▼                  │
│                                      ┌─────────────────────────────┐   │
│                                      │  Web Dashboard UI           │   │
│                                      │  • Visual dependency graphs │   │
│                                      │  • Team blast-radius diffs  │   │
│                                      └─────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start (CLI & Local MCP)

### 1. Installation

Install globally via npm or run directly using `npx`:

```bash
npm install -g ossanalyser
# or use without global installation
npx oss-analyser --help
```

### 2. Initialize in your Repository

Navigate to any codebase root and run:

```bash
cd /path/to/my-project
oss-analyser init
```

This creates a lightweight `.oss-analyser/` directory with a local SQLite database (`knowledge.db`) and automatically appends `.oss-analyser/` to `.git/info/exclude` so your git workspace remains 100% clean.

### 3. Index Codebase Structure

Extract AST symbols, link call graphs, and condense cyclic dependencies:

```bash
# Fast Zero-Token Structural Extraction (Tree-sitter)
oss-analyser index --extractor graphify

# Or use the built-in native extractor
oss-analyser index
```

### 4. Configure Your AI Coding Harness (One-Click Setup)

Automatically install MCP server configurations for your favorite IDE or harness:

```bash
# Configure for Claude Code / Claude Desktop (.mcp.json)
oss-analyser install --harness claude-code

# Configure for Cursor IDE
oss-analyser install --harness cursor

# Configure for Google Antigravity
oss-analyser install --harness antigravity
```

---

## 🛠 Complete CLI Command Reference

| Command | Syntax | Description |
|---|---|---|
| `init` | `oss-analyser init [--repo <path>] [-f]` | Initializes `.oss-analyser/` directory, SQLite database, and git exclusion. |
| `index` | `oss-analyser index [--extractor native\|graphify] [--full] [--no-blame]` | Extracts symbols, resolves call edges across files, runs Tarjan SCC, and computes git blame ownership. |
| `summarize` | `oss-analyser summarize [--estimate] [--yes] [--provider gemini\|ollama\|heuristic]` | Generates hierarchical bottom-up summaries (functions $\rightarrow$ files $\rightarrow$ modules $\rightarrow$ repo). |
| `impact` | `oss-analyser impact <symbol> [--depth <1-6>] [--include-inferred]` | Computes recursive CTE transitive blast radius and affected files for any symbol. |
| `serve` | `oss-analyser serve [--repo <path>] [--watch]` | Spawns the stdio Model Context Protocol (MCP) server for AI coding harnesses. |
| `query` | `oss-analyser query "<task>" [--mode hybrid\|lexical\|semantic] [--max-tokens <n>]` | Tests hybrid RRF retrieval in the terminal with debug ranking diagnostics. |
| `status` | `oss-analyser status [--json]` | Displays index freshness, commit hashes, symbol totals, and stale node counts. |
| `doctor` | `oss-analyser doctor` | Verifies Node.js runtime, SQLite FTS5 extension, Git binary, and API keys. |
| `install` | `oss-analyser install [--harness claude-code\|cursor\|antigravity]` | Writes MCP configuration files and slash command rules into IDE configs. |
| `export` / `sync` | `oss-analyser export [--postgres] [--dump <file.json>] [--import-dump <file.json>]` | Exports or synchronizes local SQLite graphs to a team PostgreSQL dashboard. |

### Incremental Indexing & Invalidation

When you modify files, `oss-analyser index` runs in **incremental mode**:
- Reads Git change sets (`git status --porcelain`) and SHA-256 hashes.
- Re-extracts **only modified files** in milliseconds.
- Preserves 12-character SHA-1 stable node IDs.
- Automatically marks direct callers `possibly_stale` using cascading hash invalidation.

---

## 🤖 Model Context Protocol (MCP) Tools

OSS Analyser exposes **10 standardized tools** over stdio MCP. Tools return compacted JSON envelopes with no silent item loss and explicit cursor pagination.

### Tool Catalog

#### 1. `get_relevant_context`
- **Purpose**: Hybrid Reciprocal Rank Fusion (RRF) search combining FTS5 BM25 lexical ranking and vector semantic search, automatically augmented with direct caller contracts.
- **Parameters**: `task` (string), `max_tokens` (number, default: `2000`).

#### 2. `get_blast_radius`
- **Purpose**: Calculates recursive upstream callers and affected files up to depth $N$ using SQLite recursive CTEs.
- **Parameters**: `id_or_name` (string), `max_depth` (1–6, default: `3`), `include_inferred` (boolean, default: `true`), `limit` (number or `"all"`, default: `50`), `cursor` (string).
- **Pagination**: Returns `{ total, returned, next_cursor, impactedSymbols }`.

#### 3. `get_file_contract`
- **Purpose**: Returns the public API, exported signatures, line numbers, and file summary without reading raw source code.
- **Parameters**: `path` (string), `limit` (number or `"all"`, default: `"all"`), `cursor` (string).
- **Compacted Payload**: Typically under 350 tokens, eliminating envelope bloat on small files.

#### 4. `get_symbol`
- **Purpose**: Inspects a specific function, method, or class in detail.
- **Returns**: Symbol signature, docstring, source location (`file:startLine-endLine`), summary, caller count, callee count, and top author contributors.

#### 5. `get_dependencies`
- **Purpose**: Downstream dependencies and functions called by a given symbol.
- **Parameters**: `id_or_name` (string), `depth` (1–3), `limit` (number or `"all"`, default: `50`), `cursor` (string).

#### 6. `get_callers`
- **Purpose**: Upstream functions that call a given symbol.
- **Parameters**: `id_or_name` (string), `depth` (1–3), `limit` (number or `"all"`, default: `50`), `cursor` (string).

#### 7. `get_module_summary`
- **Purpose**: High-level overview of a directory or module and its constituent files.
- **Parameters**: `path` (string), `limit` (number or `"all"`, default: `50`), `cursor` (string).

#### 8. `get_architecture_summary`
- **Purpose**: Repository-level architecture summary, detected frameworks, patterns, and entry points.

#### 9. `search_symbols`
- **Purpose**: Lexical FTS5 symbol lookup across identifiers, signatures, and summaries.
- **Parameters**: `query` (string), `limit` (number or `"all"`, default: `25`), `cursor` (string).

#### 10. `get_onboarding_guide`
- **Purpose**: Step-by-step reading order and mental model guide for new developers or agents onboarding to the repository.

---

## 🔌 IDE & Harness Integration Guides

### Google Antigravity
Add to `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "oss-analyser": {
      "command": "npx",
      "args": ["oss-analyser", "serve"],
      "env": {}
    }
  }
}
```

### Cursor IDE
Add to `.cursor/mcp.json` or Global Cursor Settings $\rightarrow$ MCP:
```json
{
  "mcpServers": {
    "oss-analyser": {
      "command": "npx",
      "args": ["oss-analyser", "serve"]
    }
  }
}
```

### Claude Desktop / Claude Code
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "oss-analyser": {
      "command": "npx",
      "args": ["oss-analyser", "serve"]
    }
  }
}
```

---

## 📊 Empirical Benchmarks

We evaluate OSS Analyser using a **reproducible 3-arm benchmark harness** against real third-party open-source codebases with frozen rubric specifications.

### Test 1: `pmndrs/zustand` (TypeScript, React State Management)

Evaluated across four developer query types comparing:
- **Arm A (Whole Source Files)**: Reading the full relevant source files.
- **Arm B (Windowed Grep)**: Keyword matching with $\pm 50$-line windows, interval merging, and whole-file token clamping (`windowTokens <= fullTokens` strictly enforced).
- **Arm C (OSS Analyser Compact MCP Payload)**: Structural graph traversal tools.

| Query ID | Category | Full Files (Tokens) | Windowed Grep (Tokens) | OSS Analyser (Tokens) | Savings vs Full Files | Savings vs Windowed | Rubric Arm A | Rubric Arm B | Rubric Arm C |
|---|---|---|---|---|---|---|---|---|---|
| `query_1_arch` | **Architecture** (Vanilla vs React) | 1,997 | 1,934 | 1,300 | **35%** | **33%** | 4/4 | 4/4 | 2/4 |
| `query_2_mechanism` | **Mechanism** (State Hydration) | 3,229 | 3,124 | 1,081 | **67%** | **65%** | 4/4 | 4/4 | 3/4 |
| `query_3_impact` | **Impact** (`createStore` Blast Radius) | 8,156 | 7,762 | 431 | **95%** | **94%** | 4/4 | 4/4 | 4/4 |
| `query_4_contract` | **Contract** (`subscribeWithSelector`) | 621 | 603 | 315 | **49%** | **48%** | 4/4 | 4/4 | 2/4 |

- **Sum-Weighted Context Reduction**: **78%** vs Full Files (14,003 $\rightarrow$ 3,127 tokens), **77%** vs Windowed Grep (13,423 $\rightarrow$ 3,127 tokens).
- **Median Context Reduction**: **58.0%** vs Full Files, **56.5%** vs Windowed Grep.
- **Contract Compaction**: Compact structural envelopes prevent JSON overhead, ensuring small files (<650 tokens) return ~300 tokens (+49% savings).

### Test 2: `encode/starlette` (Python ASGI Web Framework)

- **Scanned**: 84 Python files
- **Extracted Symbols**: 2,060 AST classes, methods, and functions
- **Resolved Edges**: 14,283 dependency and call edges
- **SCC Components**: 52 Tarjan cyclic components condensed
- **Blast Radius Example**: `get_blast_radius("Starlette", max_depth=2)` resolved 669 transitive callers across requests, middleware tests, and benchmarks in under 50ms.

---

## 👥 Optional: Self-Hosted Web Dashboard & Team Sync

While OSS Analyser is primarily a local-first CLI and MCP server, engineering teams can optionally deploy a centralized web dashboard to synchronize code summaries and share repository topologies.

### How Team Sync Works

```
Developer A (Local SQLite) ──┐
                             ├──► `oss-analyser sync` ──► Central PostgreSQL ──► Team Web Dashboard
Developer B (Local SQLite) ──┘
```

1. Developers work locally with zero latency; MCP tools query `.oss-analyser/knowledge.db`.
2. When code is pushed or indexed, run:
   ```bash
   oss-analyser sync --postgres
   ```
   This idempotently syncs the local SQLite graph to PostgreSQL with schema translation (SQLite `TEXT JSON` $\leftrightarrow$ Postgres `JSONB`) and conflict resolution via deterministic symbol IDs.
3. The team accesses the central web UI to visually explore the architecture, track blast radius on PRs, and review git ownership.

### Self-Hosting with Docker Compose

To run the central database, Redis queue, and web backend:

```bash
# Clone the repository
git clone https://github.com/your-username/ossanalyser.git
cd ossanalyser

# Start PostgreSQL (pgvector), Redis, and Web API
docker-compose up -d
```

The web backend will be available at `http://localhost:4000`.

---

## 🧪 Development & Testing

OSS Analyser includes comprehensive test suites covering schema parity, graph theory algorithms, and MCP protocols:

```bash
# Run unit & analyzer tests
npm test

# Verify 100% Postgres <-> SQLite schema parity & recursive CTE blast radius
npm run test:sqlite

# Test stdio MCP server protocol, budget trimming & item pagination
npm run test:mcp

# Verify Tree-sitter AST extraction adapter
npm run test:graphify

# Verify syntax construct regressions (generic arrows, casts, test mock disambiguation)
npm run test:regressions

# Run external empirical benchmark on pmndrs/zustand
npm run bench:external
```

---

## 📄 License

MIT © 2026 OSS Analyser Contributors. Distributed under the MIT License. See [LICENSE](./LICENSE) for details.
