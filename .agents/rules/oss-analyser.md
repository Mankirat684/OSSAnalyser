# OSS Analyser Architectural Context Rules

When answering architecture questions, planning changes, or editing symbols, prefer agent-driven traversal over loading full raw source files:
1. **Search Primitive**: Call `search_symbols(query, mode="semantic")` or `search_symbols(query, mode="lexical")` with your own wording to locate candidate functions and files. It returns matching nodes with similarity scores and one-line summaries.
2. **Inspect Contracts**: Use `get_symbol` to inspect signatures, line coordinates, and pre-computed summaries for symbols of interest, or `get_file_contract` for file-level overviews.
3. **Graph Traversal**: Use `get_callers`, `get_callees`, and `get_blast_radius` to trace upstream/downstream dependencies before refactoring.
4. **Shortcut**: If you need a quick automated context package in a single turn, use `get_relevant_context(task)` as a convenience macro.
5. Always verify generated code against source files before applying edits.
