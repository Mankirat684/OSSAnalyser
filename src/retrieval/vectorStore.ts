import * as crypto from "node:crypto";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";
import type { EmbeddingProvider } from "./embeddingProvider.js";
import { SQLiteStore } from "../storage/sqlite/sqliteStore.js";

export interface VectorSearchResult {
  nodeId: string;
  name: string;
  filePath: string;
  nodeType: string;
  signature?: string | null;
  sourcePointer?: string;
  summary?: string | null;
  similarity: number;
}

export class VectorEngine {
  private inMemoryVectors = new Map<string, { vec: Float32Array; inputHash: string }>();

  public computeInputHash(text: string, model: string): string {
    return crypto.createHash("sha256").update(`${text}::${model}`).digest("hex");
  }

  public getEmbeddedTextForNode(node: NodeRecord): string {
    if (node.nodeType === "file") {
      return `${node.filePath} ${node.summary || "file"}`.trim();
    }
    const sig = node.signature || "";
    const summary = node.summary && node.summary !== "pending_summary" ? node.summary : "";
    const doc = (node.metadata as Record<string, string>)?.doc_comment || "";
    return `${node.name} ${sig} ${summary} ${doc}`.trim();
  }

  public async embedNodes(
    store: GraphStore,
    repoId: string,
    provider: EmbeddingProvider,
    forceRebuild = false
  ): Promise<number> {
    const nodes = await store.getAllNodes(repoId);
    let embeddedCount = 0;

    const textsToEmbed: string[] = [];
    const nodesToEmbed: NodeRecord[] = [];

    const isSqlite = store instanceof SQLiteStore && store.isVecAvailable();
    const existingInDb = (!forceRebuild && isSqlite)
      ? (store as SQLiteStore).getExistingVecNodeIds()
      : new Set<string>();

    for (const node of nodes) {
      const text = this.getEmbeddedTextForNode(node);
      const hash = this.computeInputHash(text, provider.model);

      const existing = this.inMemoryVectors.get(node.id);
      if (!forceRebuild && existing && existing.inputHash === hash) {
        continue;
      }
      if (!forceRebuild && isSqlite && existingInDb.has(node.id)) {
        continue;
      }

      textsToEmbed.push(text);
      nodesToEmbed.push(node);
    }

    if (textsToEmbed.length > 0) {
      const vectors = await provider.embed(textsToEmbed, "document");
      const batchToPersist: Array<{ nodeId: string; vec: Float32Array }> = [];

      for (let i = 0; i < nodesToEmbed.length; i++) {
        const node = nodesToEmbed[i];
        const vec = vectors[i];
        const hash = this.computeInputHash(textsToEmbed[i], provider.model);

        this.inMemoryVectors.set(node.id, { vec, inputHash: hash });

        if (isSqlite) {
          batchToPersist.push({ nodeId: node.id, vec });
        }

        embeddedCount++;
      }

      if (isSqlite && batchToPersist.length > 0) {
        (store as SQLiteStore).upsertVecEmbeddingsBatch(batchToPersist);
      }
    }

    return embeddedCount;
  }

  public async search(
    queryVec: Float32Array,
    store: GraphStore,
    repoId: string,
    limit = 30
  ): Promise<VectorSearchResult[]> {
    // 1. If persistent sqlite-vec is available, use fast ANN search
    if (store instanceof SQLiteStore && store.isVecAvailable()) {
      const vecHits = (store as SQLiteStore).searchVec(queryVec, limit);
      if (vecHits.length > 0) {
        const results: VectorSearchResult[] = [];
        for (const hit of vecHits) {
          const node = await store.getNode(hit.nodeId);
          if (node) {
            // Convert L2 distance to similarity score: sim = max(0, 1 - dist^2 / 2)
            const similarity = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
            const sourcePointer =
              node.startLine != null && node.endLine != null
                ? `${node.filePath}:${node.startLine}-${node.endLine}`
                : node.startLine != null
                  ? `${node.filePath}:${node.startLine}`
                  : node.filePath;

            results.push({
              nodeId: node.id,
              name: node.name,
              filePath: node.filePath,
              nodeType: node.nodeType,
              signature: node.signature,
              sourcePointer,
              summary: node.summary,
              similarity: Math.round(similarity * 1000) / 1000
            });
          }
        }
        return results;
      }
    }

    // 2. In-memory cosine dot-product fallback
    const scored: Array<{ nodeId: string; similarity: number }> = [];

    for (const [nodeId, { vec }] of this.inMemoryVectors.entries()) {
      let dot = 0;
      const len = Math.min(queryVec.length, vec.length);
      for (let i = 0; i < len; i++) {
        dot += queryVec[i] * vec[i];
      }
      scored.push({ nodeId, similarity: dot });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const topScored = scored.slice(0, limit);

    const results: VectorSearchResult[] = [];
    for (const item of topScored) {
      const node = await store.getNode(item.nodeId);
      if (node) {
        const sourcePointer =
          node.startLine != null && node.endLine != null
            ? `${node.filePath}:${node.startLine}-${node.endLine}`
            : node.startLine != null
              ? `${node.filePath}:${node.startLine}`
              : node.filePath;

        results.push({
          nodeId: node.id,
          name: node.name,
          filePath: node.filePath,
          nodeType: node.nodeType,
          signature: node.signature,
          sourcePointer,
          summary: node.summary,
          similarity: Math.round(item.similarity * 1000) / 1000
        });
      }
    }

    return results;
  }
}
