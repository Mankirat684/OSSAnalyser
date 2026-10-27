# OSS Analyser: Context-Size & Retrieval Smoke Test Report

> **Note on Methodology:** This is an initial retrieval smoke test measuring returned context payload size against full file sizes on a single local repository. It is **not** an end-to-end task completion benchmark, does not evaluate answer quality, and uses a full-file baseline rather than a windowed grep or real agent interaction baseline.

---

## 1. Test Parameters

- **Repository Evaluated**: `ossAnalyser` (TypeScript, self-benchmark)
- **Index Mode Used**: Structural Graph & Heuristic Contracts (no LLM summarization tokens spent)
- **Token Cap Enforcement**: 2,000 token maximum ceiling on retrieval payload
- **Query Count**: 5 synthetic onboarding questions
- **Runs**: 1 single run

---

## 2. Measured Context Sizes

| Query ID | Topic | Whole-File Baseline (Tokens) | OSS Analyser Context (Tokens) | Difference | Ground Truth Symbols Retrieved in Context |
|---|---|---|---|---|---|
| `onboard_1` | Pipeline Flow | 11,366 | 1,917 | -83% | 0/4 matched (Failed) |
| `onboard_2` | Database Models & Parity | 15,883 | 1,226 | -92% | 1/4 matched (Partial) |
| `onboard_3` | MCP Server & Budgeting | 5,897 | 1,747 | -70% | 0/3 matched (Failed) |
| `onboard_4` | Subsystem Impact Radius | 9,052 | 1,856 | -79% | 1/4 matched (Partial) |
| `onboard_5` | Cycle Condensation | 3,753 | 1,780 | -53% | 1/3 matched (Partial) |

---

## 3. Summary Statistics

- **Context Payload Range**: 1,226 to 1,917 tokens (capped at 2,000)
- **Baseline File Sizes Range**: 3,753 to 15,883 tokens
- **Median Difference**: **-79%** (Unweighted mean: -75.4%)
- **Target Symbol Match Rate**: **60% failed or partial** on generic query phrasing

---

## 4. Known Limitations & Next Steps

1. **Answer Quality Grading**: Missing an LLM judge evaluating whether the returned context contains sufficient facts to answer the question accurately against a defined rubric.
2. **Baseline Inflation**: Comparing against whole files inflates apparent differences. Real agents frequently use targeted grep or windowed reads (±50 lines).
3. **Self-Referential Bias**: Evaluated exclusively against its own codebase. External repos (including a real Python repo) with third-party authored questions are required.
