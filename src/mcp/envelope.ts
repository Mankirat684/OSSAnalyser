import { execSync } from "node:child_process";
import type { GraphStore } from "../storage/graphStore.js";

export interface EnvelopeMeta {
  tokens_est: number;
  budget: number;
  truncated: boolean;
  index_commit: string;
  index_stale: boolean;
  stale_paths?: string[];
  next: string[];
}

export interface EnvelopeResponse<T = any> {
  data: T;
  meta: EnvelopeMeta;
}

export interface FormatOptions {
  budget?: number; // default 2000, hard cap 8000
  nextTools?: string[];
  repoRoot?: string;
}

export interface PaginatedList<T> {
  total: number;
  returned: number;
  next_cursor: string | null;
  items: T[];
}

/**
 * Strips null, undefined, and empty arrays from an object recursively to eliminate JSON envelope overhead.
 */
export function compactJson<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map(compactJson) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const cleaned: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      cleaned[k] = compactJson(v);
    }
    return cleaned as T;
  }
  return obj;
}

/**
 * Paginates a list of items by item count with explicit total, returned, and next_cursor.
 * If limit is 'all' or -1, returns all items with next_cursor = null.
 * Never drops items silently.
 */
export function paginateItems<T>(
  allItems: T[],
  limitInput?: number | "all" | string,
  cursorInput?: string | null,
  defaultLimit = 50
): PaginatedList<T> {
  const total = allItems.length;

  if (limitInput === "all" || limitInput === -1) {
    return {
      total,
      returned: total,
      next_cursor: null,
      items: allItems
    };
  }

  const parsedLimit = typeof limitInput === "number"
    ? limitInput
    : typeof limitInput === "string" && !isNaN(parseInt(limitInput, 10))
      ? parseInt(limitInput, 10)
      : defaultLimit;

  const limit = parsedLimit > 0 ? parsedLimit : defaultLimit;
  const offset = cursorInput ? Math.max(0, parseInt(cursorInput, 10) || 0) : 0;

  const end = Math.min(offset + limit, total);
  const items = allItems.slice(offset, end);
  const next_cursor = end < total ? String(end) : null;

  return {
    total,
    returned: items.length,
    next_cursor,
    items
  };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class EnvelopeBuilder {
  public static async createMeta(
    store: GraphStore,
    budget?: number,
    nextTools: string[] = [],
    repoRoot?: string
  ): Promise<EnvelopeMeta> {
    const effectiveBudget = budget && budget > 0 ? budget : Infinity;
    const lastCommit = (await store.getMeta("last_indexed_commit")) || "untracked";

    let indexStale = false;
    let stalePaths: string[] = [];

    if (repoRoot) {
      try {
        const dirtyOutput = execSync("git status --porcelain", {
          cwd: repoRoot,
          stdio: ["pipe", "pipe", "ignore"],
          encoding: "utf-8"
        }).trim();
        if (dirtyOutput.length > 0) {
          indexStale = true;
          stalePaths = dirtyOutput
            .split(/\r?\n/)
            .map((l) => l.slice(3).trim())
            .filter(Boolean)
            .slice(0, 10);
        }
      } catch {
        // Not a git repo
      }
    }

    const metaRecord: EnvelopeMeta = {
      tokens_est: 0,
      budget: effectiveBudget,
      truncated: false,
      index_commit: lastCommit,
      index_stale: indexStale,
      next: nextTools
    };
    if (indexStale && stalePaths.length > 0) {
      metaRecord.stale_paths = stalePaths;
    }

    return metaRecord;
  }

  public static wrap<T extends Record<string, any>>(
    data: T,
    meta: EnvelopeMeta
  ): { content: Array<{ type: "text"; text: string }> } {
    let cleanedData = compactJson(data);
    let payload: EnvelopeResponse<T> = { data: cleanedData, meta };
    let jsonStr = JSON.stringify(payload, null, 2);
    let est = estimateTokens(jsonStr);

    // Enforce budget only if an explicit finite budget was requested
    if (meta.budget !== Infinity && est > meta.budget) {
      meta.truncated = true;
      const trimmedData: Record<string, any> = { ...cleanedData };

      // Trim array fields in data progressively
      for (const key of Object.keys(trimmedData)) {
        if (Array.isArray(trimmedData[key])) {
          while (trimmedData[key].length > 1 && estimateTokens(JSON.stringify({ data: trimmedData, meta }, null, 2)) > meta.budget) {
            trimmedData[key] = trimmedData[key].slice(0, Math.floor(trimmedData[key].length * 0.7));
          }
        }
      }

      payload = { data: trimmedData as T, meta };
      jsonStr = JSON.stringify(payload, null, 2);
      est = estimateTokens(jsonStr);
    }

    meta.tokens_est = est;
    const finalOutput = JSON.stringify(payload, null, 2);

    return {
      content: [
        {
          type: "text",
          text: finalOutput
        }
      ]
    };
  }
}
