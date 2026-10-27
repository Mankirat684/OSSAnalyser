# OSS Analyser: Retrieval Context Size & Symbol Recall Test

> **Methodological Disclaimer:** This report measures single-query retrieval context sizes and top-rank symbol matches against full source files on the local repository. It does not measure end-to-end agent task completion or answer correctness.

---

## 1. Parameters

- **Target Repo**: `ossAnalyser` (TypeScript, self-benchmark)
- **Index Mode**: Structural Graph + Heuristic Signatures (0 LLM tokens spent during indexing)
- **Context Cap**: Bounded at 2,000 tokens maximum per retrieval envelope

---

## 2. Results

| Task ID | Category | Whole-File Size (Tokens) | Returned Context Size (Tokens) | Context Size Difference | Target Symbols Located |
|---|---|---|---|---|---|
| `task_1` | Architecture | 8,724 | 1,990 | -77% | `SQLiteStore` (Rank 1) |
| `task_2` | Impact | 8,268 | 1,147 | -86% | `SQLiteStore`, `getBlastRadius` |
| `task_3` | Architecture | 3,400 | 705 | -79% | `condenseGraphWithTarjan`, `computeBottomUpTopoLevels` |
| `task_4` | Feature | 857 | 1,936 | +126% | `SecretScanner` |
| `task_5` | Bugfix | 3,682 | 1,860 | -49% | `IncrementalDetector` |

---

## 3. Observations

- For large file clusters (`task_1`, `task_2`), returned context payload is strictly bounded (705–1,990 tokens).
- For small targeted lookups (`task_4`), the 2,000-token envelope packs additional context, resulting in a larger payload than reading the individual 200-line source file directly.
- **Median context reduction**: -77% against whole-file baselines.
