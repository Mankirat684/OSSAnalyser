import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { extractGitOwnershipForRange, type GitBlameCache } from "../git/gitBlame.js";
import type { AuthorOwnership } from "../../core/types.js";

export interface BlameNodeInput {
  id: string;
  source_file: string;
  start_line?: number;
  end_line?: number;
}

export interface BlameWorkerTask {
  repoRoot: string;
  nodes: BlameNodeInput[];
}

export interface BlameWorkerResult {
  success: boolean;
  ownershipMap: Record<string, AuthorOwnership[]>;
  error?: string;
}

// -----------------------------------------------------------------------------
// WORKER THREAD EXECUTION: Runs entirely off the main event loop
// -----------------------------------------------------------------------------
if (!isMainThread) {
  try {
    const { repoRoot, nodes } = workerData as BlameWorkerTask;
    const cache: GitBlameCache = new Map();
    const ownershipMap: Record<string, AuthorOwnership[]> = {};

    for (const node of nodes) {
      ownershipMap[node.id] = extractGitOwnershipForRange(
        repoRoot,
        node.source_file,
        node.start_line,
        node.end_line,
        cache
      );
    }

    parentPort?.postMessage({
      success: true,
      ownershipMap
    } satisfies BlameWorkerResult);
  } catch (err: any) {
    parentPort?.postMessage({
      success: false,
      ownershipMap: {},
      error: err?.message || String(err)
    } satisfies BlameWorkerResult);
  }
}

// -----------------------------------------------------------------------------
// MAIN THREAD HELPER: Spawns worker thread, keeping main event loop responsive
// -----------------------------------------------------------------------------
export function extractGitOwnershipInWorkerThread(
  task: BlameWorkerTask
): Promise<Record<string, AuthorOwnership[]>> {
  return new Promise((resolve) => {
    if (!task.nodes || task.nodes.length === 0) {
      return resolve({});
    }

    try {
      const worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: task
      });

      let resolved = false;

      worker.on("message", (result: BlameWorkerResult) => {
        if (!resolved) {
          resolved = true;
          if (result.success) {
            resolve(result.ownershipMap);
          } else {
            console.warn(`[GitBlameWorker] Worker error: ${result.error}. Falling back to inline execution.`);
            resolve(fallbackOwnership(task));
          }
        }
      });

      worker.on("error", (err: Error) => {
        if (!resolved) {
          resolved = true;
          console.warn(`[GitBlameWorker] Worker thread exception: ${err.message}. Falling back to inline execution.`);
          resolve(fallbackOwnership(task));
        }
      });

      worker.on("exit", (code) => {
        if (!resolved) {
          resolved = true;
          if (code !== 0) {
            console.warn(`[GitBlameWorker] Worker exited with code ${code}. Falling back to inline execution.`);
          }
          resolve(fallbackOwnership(task));
        }
      });
    } catch (spawnErr: any) {
      console.warn(`[GitBlameWorker] Could not spawn worker thread: ${spawnErr.message}. Executing inline.`);
      resolve(fallbackOwnership(task));
    }
  });
}

function fallbackOwnership(task: BlameWorkerTask): Record<string, AuthorOwnership[]> {
  const cache: GitBlameCache = new Map();
  const map: Record<string, AuthorOwnership[]> = {};
  for (const node of task.nodes) {
    map[node.id] = extractGitOwnershipForRange(
      task.repoRoot,
      node.source_file,
      node.start_line,
      node.end_line,
      cache
    );
  }
  return map;
}
