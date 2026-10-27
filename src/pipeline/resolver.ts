import type { ExtractedSymbol, ExtractedEdge } from "./extractor.js";
import type { EdgeRecord, UnresolvedRefRecord } from "../storage/graphStore.js";

export interface ResolveResult {
  edges: EdgeRecord[];
  unresolved: UnresolvedRefRecord[];
}

export class EdgeResolver {
  public resolve(
    repoId: string,
    rawEdges: ExtractedEdge[],
    symbols: ExtractedSymbol[]
  ): ResolveResult {
    const symbolById = new Map<string, ExtractedSymbol>();
    const symbolsByName = new Map<string, ExtractedSymbol[]>();
    const symbolsByFileAndName = new Map<string, ExtractedSymbol>();

    for (const sym of symbols) {
      symbolById.set(sym.id, sym);

      const list = symbolsByName.get(sym.name) || [];
      list.push(sym);
      symbolsByName.set(sym.name, list);

      symbolsByFileAndName.set(`${sym.filePath}::${sym.name}`, sym);
      symbolsByFileAndName.set(`${sym.filePath}::${sym.qualifiedName}`, sym);
    }

    const resolvedEdges: EdgeRecord[] = [];
    const unresolved: UnresolvedRefRecord[] = [];
    const seenEdges = new Set<string>();

    for (const raw of rawEdges) {
      const sourceSym = symbolById.get(raw.sourceId);
      if (!sourceSym) continue;

      let targetSymId: string | null = null;
      let confidence = raw.confidence;

      // 1. Direct ID match (e.g. contains edges)
      if (symbolById.has(raw.targetName)) {
        targetSymId = raw.targetName;
        confidence = "EXTRACTED";
      }

      // 2. Same-file match
      if (!targetSymId && sourceSym) {
        const sameFileHit = symbolsByFileAndName.get(`${sourceSym.filePath}::${raw.targetName}`);
        if (sameFileHit) {
          targetSymId = sameFileHit.id;
          confidence = "EXTRACTED";
        }
      }

      // 3. Global name match with candidate disambiguation
      if (!targetSymId) {
        const candidates = symbolsByName.get(raw.targetName);
        if (candidates && candidates.length === 1) {
          targetSymId = candidates[0].id;
          confidence = raw.confidence === "EXTRACTED" ? "EXTRACTED" : "INFERRED";
        } else if (candidates && candidates.length > 1) {
          // Disambiguation heuristic:
          // A. Filter out test/fixture files if possible
          const nonTest = candidates.filter(
            (c) => !/[\\/](tests?|__tests__|spec|fixtures?)[\\/]|\.(test|spec)\./i.test(c.filePath)
          );
          const pool = nonTest.length > 0 ? nonTest : candidates;

          if (pool.length === 1) {
            targetSymId = pool[0].id;
            confidence = "INFERRED";
          } else {
            // B. Prefer exported symbols
            const exported = pool.filter((c) => c.exported);
            if (exported.length === 1) {
              targetSymId = exported[0].id;
              confidence = "INFERRED";
            } else {
              // C. Closest directory match (longest common path prefix with source file)
              const sourceDir = sourceSym.filePath.split("/").slice(0, -1).join("/");
              let bestMatch = pool[0];
              let bestMatchScore = -1;
              for (const cand of (exported.length > 0 ? exported : pool)) {
                const candDir = cand.filePath.split("/").slice(0, -1).join("/");
                let score = 0;
                while (score < sourceDir.length && score < candDir.length && sourceDir[score] === candDir[score]) {
                  score++;
                }
                if (score > bestMatchScore) {
                  bestMatchScore = score;
                  bestMatch = cand;
                }
              }
              if (bestMatchScore > 0) {
                targetSymId = bestMatch.id;
                confidence = "INFERRED";
              }
            }
          }
        }
      }

      // 4. Result partitioning
      if (targetSymId) {
        const edgeKey = `${raw.sourceId}->${targetSymId}:${raw.relation}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          resolvedEdges.push({
            repoId,
            sourceId: raw.sourceId,
            targetId: targetSymId,
            relation: raw.relation,
            confidence,
            metadata: raw.line ? { lines: [raw.line] } : {}
          });
        }
      } else {
        unresolved.push({
          repoId,
          sourceId: raw.sourceId,
          targetName: raw.targetName,
          relation: raw.relation,
          confidence: "INFERRED",
          line: raw.line ?? null
        });
      }
    }

    return {
      edges: resolvedEdges,
      unresolved
    };
  }
}
