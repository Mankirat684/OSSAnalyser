---
description: Consult OSS Analyser for architecture, call graphs, and blast radius before editing
---

When tackling code-understanding, feature development, or refactoring tasks, drive your own traversal using OSS Analyser primitives:
1. **Search Primitive**: Call `search_symbols(query, mode="semantic")` or `search_symbols(query, mode="lexical")` with your own keywords or questions to discover candidate symbols and their pre-computed summaries.
2. **Inspect Contracts**: Call `get_symbol` or `get_file_contract` on targets to inspect signatures, line coordinates, and doc summaries without loading full files.
3. **Graph Traversal**: Call `get_callers` or `get_callees` to trace dependencies, and `get_blast_radius` before modifying a symbol to inspect upstream impact.
4. *(Optional Shortcut)*: For a quick one-shot context bundle, `get_relevant_context` is available as an automated macro.
5. Always verify code against source files before applying edits.
