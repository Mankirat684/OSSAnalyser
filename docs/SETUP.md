# OSS Analyser Setup & Integration Guide

A local-first context engine and Model Context Protocol (MCP) server for AI coding agents (Claude Code, Cursor, Windsurf, Antigravity).

---

## 🚀 Quick Start (Zero Infrastructure)

### 1. Initialize
Run inside any project repository root:
```bash
npx oss-analyser init
```
This sets up `.oss-analyser/` with an SQLite database and registers it in `.git/info/exclude` to keep git clean.

### 2. Index Structure
Extract AST symbols, call graphs, and cycle structures:
```bash
npx oss-analyser index
```
- Incremental: Subsequent runs re-extract only changed files in sub-second time.
- Cycle-Safe: Condenses mutual import and recursion cycles via Tarjan's SCC.

### 3. Hierarchical Summarization (Optional, User-Triggered)
Estimate token costs first:
```bash
npx oss-analyser summarize --estimate
```
Run bottom-up hierarchical summarization:
```bash
npx oss-analyser summarize
```
- Supports cloud (Gemini) or 100% offline local (Ollama / Heuristics).
- Checkpoint Resumption: Interrupted runs resume with 0 duplicate token spend.

### 4. Query Context Locally
Test the retrieval engine from your terminal:
```bash
npx oss-analyser query "how does blast radius work?"
```

### 5. Inspect Blast Radius
Check upstream affected callers before editing any function or class:
```bash
npx oss-analyser impact <symbol_or_path>
```

---

## 🤖 Harness Integration (Model Context Protocol)

### One-Command Setup
```bash
npx oss-analyser install
```
This automatically creates or merges `.mcp.json` and adds slash commands (`/ossAnalyse`, `/summarize`) in `.claude/commands/`.

### Manual `.mcp.json` Configuration
For Claude Code, Cursor, or Windsurf, configure `.mcp.json` in your workspace root:

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

## 🛠 Available MCP Tools

AI agents connected over MCP have access to 11 compact, budget-enforced tools:

| MCP Tool | Description |
|---|---|
| `get_relevant_context` | Primary agent tool. Hybrid RRF context package with direct callers, file contracts, and relevance explanations. |
| `search_symbols` | Hybrid lexical and semantic search for symbols with source pointers. |
| `get_symbol` | Symbol signature, summary, authorship, caller/callee counts, and SCC cycle group. |
| `get_file_contract` | File purpose, exported symbols, and architectural contract without loading raw source. |
| `get_module_summary` | Directory rollup and child components. |
| `get_dependencies` | Downstream functions/modules called by a symbol. |
| `get_callers` | Upstream callers that invoke a symbol. |
| `get_blast_radius` | Transitive upstream callers and affected files using recursive graph traversal. |
| `get_owners` | Top git contributors, line percentages, and authorship history. |
| `get_architecture_summary` | High-level repository architecture overview or onboarding guide. |
| `index_status` | Commit freshness, symbol counts, and summary coverage. |

---

## 🔒 Privacy & Security

- **Zero Secrets Sent**: Built-in regex scanner automatically redacts AWS keys, private keys, API tokens, and JWTs with `[REDACTED]`.
- **Path Traversal Guard**: Prevents accessing files outside the repository root.
- **Local SQLite**: Database resides entirely on your machine at `.oss-analyser/knowledge.db`.
