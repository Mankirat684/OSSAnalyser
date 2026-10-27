import * as crypto from "node:crypto";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";

export const CURRENT_PROMPT_VERSION = "v1";

export class InvalidationManager {
  /**
   * Computes summary_input_hash for a symbol per Section 6.2:
   * sha256(symbol.source_hash + sorted(callee.summary_content_hash for each deterministic callee) + prompt_version)
   */
  public static computeSymbolInputHash(
    sourceHash: string,
    calleeContentHashes: string[],
    promptVersion = CURRENT_PROMPT_VERSION
  ): string {
    const sortedHashes = [...calleeContentHashes].sort().join("");
    return crypto
      .createHash("sha256")
      .update(`${sourceHash}${sortedHashes}${promptVersion}`)
      .digest("hex");
  }

  /**
   * Computes summary_content_hash: sha256 of summary text.
   */
  public static computeSummaryContentHash(summaryText: string): string {
    return crypto.createHash("sha256").update(summaryText.trim()).digest("hex");
  }

  /**
   * Propagates staleness on `index` when a symbol's source_hash changes:
   * - Changed symbol -> marked 'stale'
   * - Direct callers -> marked 'possibly_stale' (only if previously 'fresh')
   * - Zero transitive cascading!
   */
  public static async propagateSourceChange(
    store: GraphStore,
    changedSymbolId: string
  ): Promise<void> {
    await store.updateSummaryStatus(changedSymbolId, "stale");
    await store.markCallersPossiblyStale(changedSymbolId);
  }
}
