# Expected import relationships

Use these as a manual checklist when inspecting Graphify's output. The exact representation and edge direction depend on Graphify's schema.

- `src/index.ts` -> `src/services/userService.ts`
- `src/services/userService.ts` -> `src/repositories/userRepository.ts`
- `src/services/userService.ts` -> `src/models/user.ts`
- `src/services/userService.ts` -> `src/utils/format.ts`
- `src/repositories/userRepository.ts` -> `src/models/user.ts`
- `src/cycle/a.ts` <-> `src/cycle/b.ts` (intentional cycle)

The main application path is acyclic. The `src/cycle` pair deliberately forms a strongly connected component if both import edges are extracted correctly.
