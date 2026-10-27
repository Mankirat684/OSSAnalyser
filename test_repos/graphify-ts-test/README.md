# Graphify TypeScript Test Repository

A tiny TypeScript project for testing Graphify's code graph extraction.

## Layout

- `src/index.ts` imports and calls `UserService`.
- `src/services/userService.ts` imports the repository, model, and formatter.
- `src/repositories/userRepository.ts` imports the `User` model.
- `src/utils/format.ts` is a standalone utility.
- `src/cycle/a.ts` and `src/cycle/b.ts` deliberately import each other to test cycle detection.

## Run Graphify

From this directory in PowerShell:

```powershell
uv tool run --from graphifyy graphify extract . --code-only --no-cluster
```

Then inspect the output:

```powershell
Get-ChildItem .\graphify-out
Get-Content .\graphify-out\graph.json -TotalCount 150
```

The intended dependency edges are documented in `EXPECTED-EDGES.md`. Graphify's output schema and edge labels may differ, so inspect the JSON rather than assuming a particular format.
