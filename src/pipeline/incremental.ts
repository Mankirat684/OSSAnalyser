import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { normalizeRelPath } from "./idGenerator.js";
import type { GraphStore, NodeRecord } from "../storage/graphStore.js";

export interface FileChangeSet {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: string[];
  allCurrentFiles: Map<string, string>; // relPath -> sha256
}

const DENY_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /\.p12$/i,
  /credentials/i
];

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".oss-analyser",
  "dist",
  "build",
  "coverage",
  ".next",
  ".cache"
]);

const IGNORED_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".mp4", ".mov", ".zip", ".tar", ".gz", ".tgz", ".pdf",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm",
  ".lock", ".map"
]);

export class IncrementalDetector {
  public static discoverFiles(repoRoot: string, maxSizeBytes = 1024 * 1024): Map<string, string> {
    const fileMap = new Map<string, string>(); // relPath -> sha256

    // Read .ossignore if present
    const ossIgnorePath = path.join(repoRoot, ".ossignore");
    const customIgnorePatterns: RegExp[] = [];
    if (fs.existsSync(ossIgnorePath)) {
      const lines = fs.readFileSync(ossIgnorePath, "utf-8").split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          customIgnorePatterns.push(new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
      }
    }

    function walk(dir: string) {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            walk(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const fileName = entry.name;
          const ext = path.extname(fileName).toLowerCase();

          // Deny-list checks
          if (IGNORED_EXTS.has(ext)) continue;
          if (fileName === "package-lock.json" || fileName === "yarn.lock" || fileName === "pnpm-lock.yaml") continue;
          if (DENY_PATTERNS.some((p) => p.test(fileName))) continue;
          if (customIgnorePatterns.some((p) => p.test(fileName))) continue;

          // Only supported code files for MVP
          if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(ext)) {
            continue;
          }

          const fullPath = path.join(dir, fileName);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > maxSizeBytes) continue;

            const content = fs.readFileSync(fullPath);
            const hash = crypto.createHash("sha256").update(content).digest("hex");
            const relPath = normalizeRelPath(path.relative(repoRoot, fullPath));
            fileMap.set(relPath, hash);
          } catch {
            // Unreadable file; ignore
          }
        }
      }
    }

    walk(repoRoot);
    return fileMap;
  }

  public static async detectChanges(
    repoRoot: string,
    repoId: string,
    store: GraphStore
  ): Promise<FileChangeSet> {
    const currentFiles = this.discoverFiles(repoRoot);
    const existingFileNodes = await store.getAllNodes(repoId, "file");
    const existingMap = new Map<string, NodeRecord>();
    for (const f of existingFileNodes) {
      existingMap.set(normalizeRelPath(f.filePath), f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const unchanged: string[] = [];
    const deleted: string[] = [];

    // Check added, modified, unchanged
    for (const [relPath, currentHash] of currentFiles.entries()) {
      const existing = existingMap.get(relPath);
      if (!existing) {
        added.push(relPath);
      } else if (existing.sourceHash !== currentHash) {
        modified.push(relPath);
      } else {
        unchanged.push(relPath);
      }
    }

    // Check deleted
    for (const relPath of existingMap.keys()) {
      if (!currentFiles.has(relPath)) {
        deleted.push(relPath);
      }
    }

    return {
      added,
      modified,
      deleted,
      unchanged,
      allCurrentFiles: currentFiles
    };
  }
}
